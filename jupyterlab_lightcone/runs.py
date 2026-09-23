"""Materialization history from Git, and `lc materialize` jobs this server runs.

Every output the engine makes is committed as `[DATALAD RUNCMD] <output>
[<universe>]` with the command, inputs, outputs and exit code in the message,
so the run history is read from Git alone. Jobs started from the UI are
supervised here as process groups; their progress reaches the browser through
the Jupyter Server event bus and the snapshot routes below.
"""

import asyncio
import codecs
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from uuid import uuid4

from jupyter_server.auth import authorized
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import project_root

JOB_SCHEMA_ID = "https://events.lightcone.dev/jupyterlab_lightcone/job/v1"
JOB_SCHEMA_PATH = Path(__file__).parent / "event_schemas" / "job.yaml"
JOBS_SETTING = "lightcone_jobs"
"""The web application setting holding this server's `JobRegistry`."""
HANDLERS_SETTING = "lightcone_runs_handlers"

MAX_RUNS = 200
MAX_JOBS = 20
MAX_LINES = 200
MAX_REPORT_LINES = 5000
MAX_LINE_CHARS = 65536
MAX_TARGETS = 100
KILL_GRACE_SECONDS = 10
GIT_TIMEOUT = 30

RUN_SUBJECT = re.compile(r"^\[DATALAD RUNCMD\] (\S+) \[(\S+)\]$")
RECORD_START = "=== Do not change lines below ==="
RECORD_END = "^^^ Do not change lines above ^^^"
TARGET = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,199}$")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
JSON_LINE = re.compile(r"^\{", re.MULTILINE)


# =============================================================================
# Run history
# =============================================================================


def _strings(value) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def parse_run_record(body: str) -> dict:
    """The command, exit code, inputs and outputs of a DATALAD run record.

    The record is the JSON block datalad writes between its two marker lines.
    A commit without a readable block still counts as a run; its fields are
    then empty rather than the whole commit being dropped.
    """
    empty = {"cmd": "", "exit": None, "inputs": [], "outputs": []}
    start = body.find(RECORD_START)
    end = body.rfind(RECORD_END)
    if start < 0 or end < start:
        return empty
    try:
        info = json.loads(body[start + len(RECORD_START):end])
    except ValueError:
        return empty
    if not isinstance(info, dict):
        return empty
    cmd = info.get("cmd")
    exit_code = info.get("exit")
    return {
        "cmd": cmd if isinstance(cmd, str) else "",
        "exit": exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None,
        "inputs": _strings(info.get("inputs")),
        "outputs": _strings(info.get("outputs")),
    }


def parse_run(entry: str) -> dict | None:
    """One `git log` entry, formatted `%H%x1f%cI%x1f%s%x1f%B`, as a run.

    Returns None for a commit whose subject is not a materialization record.
    """
    parts = entry.split("\x1f", 3)
    if len(parts) != 4:
        return None
    commit, time_, subject, body = parts
    match = RUN_SUBJECT.match(subject.strip())
    if match is None:
        return None
    return {
        "commit": commit,
        "short": commit[:7],
        "time": time_,
        "output": match.group(1),
        "universe": match.group(2),
        **parse_run_record(body),
    }


def run_history(project: Path, limit: int = MAX_RUNS) -> list[dict]:
    """The project's materialization commits, newest first; empty outside Git."""
    try:
        result = subprocess.run(
            [
                "git",
                "log",
                f"--max-count={limit}",
                "--format=%H%x1f%cI%x1f%s%x1f%B%x1e",
                "--grep=^\\[DATALAD RUNCMD\\]",
            ],
            cwd=project,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    runs = []
    for entry in result.stdout.split("\x1e"):
        run = parse_run(entry.strip())
        if run is not None:
            runs.append(run)
    return runs


# =============================================================================
# Jobs
# =============================================================================


def materialize_command(targets: list[str], refresh: bool) -> list[str]:
    """The engine invocation for a job: this interpreter's `lc materialize --json`.

    The CLI module is run through the interpreter rather than a console script,
    so the job uses the engine installed beside this server whatever is on PATH.
    """
    return [
        sys.executable,
        "-c",
        "import sys; from lightcone.cli.commands import main; sys.exit(main())",
        "materialize",
        "--json",
        *(["--refresh"] if refresh else []),
        *targets,
    ]


def validate_targets(value) -> list[str]:
    """Output ids such as `hubble_diagram` or `baseline/hubble_diagram`, or a 400."""
    if (
        not isinstance(value, list)
        or len(value) > MAX_TARGETS
        or any(not isinstance(target, str) or TARGET.match(target) is None for target in value)
    ):
        raise web.HTTPError(400, "targets must be a list of output ids such as baseline/hubble_diagram.")
    return list(value)


def parse_last_json(text: str) -> dict | None:
    """The last JSON object starting at a line start, as `lc --json` prints its report."""
    decoder = json.JSONDecoder()
    for match in reversed(list(JSON_LINE.finditer(text))):
        try:
            value, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def contents_path(root: Path, project: Path) -> str:
    """The Jupyter Contents path of a project directory; empty for the root itself."""
    relative = project.relative_to(root).as_posix()
    return "" if relative == "." else relative


@dataclass
class Job:
    """One `lc materialize` run started from the UI and its bounded output."""

    id: str
    project: str
    directory: Path
    targets: list[str]
    refresh: bool
    started: str
    state: str = "running"
    finished: str | None = None
    exit: int | None = None
    lines: deque = field(default_factory=lambda: deque(maxlen=MAX_LINES))
    report: dict | None = None
    stdout: deque = field(default_factory=lambda: deque(maxlen=MAX_REPORT_LINES))
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = None

    def payload(self) -> dict:
        """The frontend contract: every field present, null where absent."""
        return {
            "id": self.id,
            "project": self.project,
            "targets": list(self.targets),
            "refresh": self.refresh,
            "state": self.state,
            "started": self.started,
            "finished": self.finished,
            "exit": self.exit,
            "lines": list(self.lines),
            "report": self.report,
        }


async def _exited(process, timeout=None) -> bool:
    """Wait for the engine parent to exit without waiting for its pipes.

    asyncio's Process.wait() also waits for inherited pipes to close, which an
    orphaned grandchild can hold open; the child watcher sets returncode as
    soon as the parent itself is gone.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    while process.returncode is None:
        if deadline is not None and time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.1)
    return True


async def _terminate(process, grace: float) -> None:
    """Stop the whole process group: SIGTERM, then SIGKILL after `grace` seconds."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if await _exited(process, grace):
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    await _exited(process)


def _kill_group(process) -> None:
    """Reap descendants the exited engine left behind, so they cannot hold its pipes."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class JobRegistry:
    """This server's materialization jobs, in memory, supervised as process groups."""

    def __init__(self, log, event_logger=None):
        self.jobs: dict[str, Job] = {}
        self.log = log
        self.event_logger = event_logger
        self.grace = KILL_GRACE_SECONDS

    def listing(self, project: str) -> list[dict]:
        """The project's jobs in every state, newest first, capped."""
        jobs = [job for job in reversed(self.jobs.values()) if job.project == project]
        return [job.payload() for job in jobs[:MAX_JOBS]]

    def running(self, project: str) -> Job | None:
        """The project's running job, if any: there is at most one."""
        return next((job for job in self.jobs.values() if job.project == project and job.state == "running"), None)

    def get(self, job_id: str, project: str) -> Job | None:
        """A job by id, only within the project the request was authorized for."""
        job = self.jobs.get(job_id)
        return job if job is not None and job.project == project else None

    def start(self, directory: Path, project: str, targets: list[str], refresh: bool) -> Job:
        """Register a job and start supervising it; the caller ensured none is running."""
        job = Job(
            id=str(uuid4()),
            project=project,
            directory=directory,
            targets=list(targets),
            refresh=refresh,
            started=_now(),
        )
        self.jobs[job.id] = job
        self._prune(project)
        job.task = asyncio.create_task(self._run(job))
        return job

    def _prune(self, project: str) -> None:
        """Forget the oldest finished jobs of a project beyond the listing cap."""
        finished = [job for job in self.jobs.values() if job.project == project and job.state != "running"]
        for job in finished[: max(0, len(finished) - MAX_JOBS)]:
            del self.jobs[job.id]

    async def cancel(self, job: Job, grace: float | None = None) -> None:
        """Terminate a running job and wait for its record to be final."""
        if job.state != "running":
            return
        job.state = "cancelled"
        self.log.info("Cancelling Lightcone materialization %s in %s", job.id, job.directory)
        if job.process is not None:
            await _terminate(job.process, self.grace if grace is None else grace)
        if job.task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(job.task), 15)
            except asyncio.TimeoutError:
                self.log.warning("Lightcone materialization %s did not stop in time", job.id)

    async def close(self) -> None:
        """Stop every running job; called from the extension's shutdown lifecycle."""
        running = [job for job in self.jobs.values() if job.state == "running"]
        await asyncio.gather(*(self.cancel(job, grace=2) for job in running))

    async def _run(self, job: Job) -> None:
        """Supervise one engine process group from spawn to its final record."""
        readers = []
        try:
            if job.state != "running":
                return
            env = dict(os.environ, PYTHONUNBUFFERED="1", NO_COLOR="1")
            try:
                job.process = await asyncio.create_subprocess_exec(
                    *materialize_command(job.targets, job.refresh),
                    cwd=job.directory,
                    env=env,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
            except OSError as error:
                self._record(job, f"Could not start the Lightcone engine: {error}", False)
                return
            self._emit(job, None)
            if job.state != "running":
                # Cancelled while spawning: nothing must run.
                await _terminate(job.process, 0)
            readers = [
                asyncio.create_task(self._read(job, job.process.stdout, True)),
                asyncio.create_task(self._read(job, job.process.stderr, False)),
            ]
            await _exited(job.process)
            deadline = time.monotonic() + 5
            for reader in readers:
                try:
                    await asyncio.wait_for(asyncio.shield(reader), max(0.0, deadline - time.monotonic()))
                except asyncio.TimeoutError:
                    break
            # Grandchildren may still hold the pipes; the engine is gone, so reap them.
            _kill_group(job.process)
        except asyncio.CancelledError:
            if job.process is not None:
                _kill_group(job.process)
            raise
        finally:
            for reader in readers:
                reader.cancel()
            if readers:
                await asyncio.gather(*readers, return_exceptions=True)
            self._finish(job)

    def _finish(self, job: Job) -> None:
        """Record the outcome once and announce it."""
        if job.finished is not None:
            return
        process = job.process
        job.exit = None if process is None else process.returncode
        job.finished = _now()
        job.report = parse_last_json("\n".join(job.stdout))
        if job.state == "running":
            job.state = "succeeded" if job.exit == 0 else "failed"
        self.log.info("Lightcone materialization %s %s (exit %s)", job.id, job.state, job.exit)
        self._emit(job, None)

    async def _read(self, job: Job, stream, is_stdout: bool) -> None:
        """Turn a pipe into lines as they arrive; a chunk may end mid-character or mid-line."""
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        while True:
            chunk = await stream.read(4096)
            pending += decoder.decode(chunk, final=not chunk)
            *lines, pending = pending.split("\n")
            if len(pending) > MAX_LINE_CHARS or (not chunk and pending):
                lines.append(pending)
                pending = ""
            for line in lines:
                self._record(job, line.rstrip("\r"), is_stdout)
            if not chunk:
                return

    def _record(self, job: Job, line: str, is_stdout: bool) -> None:
        """Keep the bounded log, the stdout the report is parsed from, and tell listeners."""
        clean = ANSI_ESCAPE.sub("", line)
        job.lines.append(clean)
        if is_stdout:
            job.stdout.append(line)
        self._emit(job, clean)

    def _emit(self, job: Job, line: str | None) -> None:
        """Publish on the event bus when the schema is registered; never fail the job."""
        logger = self.event_logger
        if logger is None or JOB_SCHEMA_ID not in logger.schemas:
            return
        try:
            logger.emit(
                schema_id=JOB_SCHEMA_ID,
                data={"id": job.id, "project": job.project, "state": job.state, "line": line},
            )
        except Exception:
            self.log.warning("Could not publish a Lightcone job event.", exc_info=True)


def job_registry(settings: dict) -> JobRegistry:
    """The server's registry, created on first use under `lightcone_jobs`."""
    registry = settings.get(JOBS_SETTING)
    if not isinstance(registry, JobRegistry):
        registry = JobRegistry(settings.get("log") or logging.getLogger(__name__), settings.get("event_logger"))
        settings[JOBS_SETTING] = registry
    return registry


def setup_job_events(serverapp) -> None:
    """Register the job event schema once; the extension app calls this at load."""
    logger = serverapp.event_logger
    if JOB_SCHEMA_ID not in logger.schemas:
        logger.register_event_schema(JOB_SCHEMA_PATH)


async def close_jobs(web_app) -> None:
    """Stop running jobs before Jupyter exits; a no-op when none were started."""
    registry = web_app.settings.get(JOBS_SETTING)
    if isinstance(registry, JobRegistry):
        await registry.close()


# =============================================================================
# Routes
# =============================================================================


async def authorized_project(handler: ProjectAPIHandler, path) -> Path:
    """Resolve and authorize an entrypoint given in a request body, as `project()` does for queries."""
    if not isinstance(path, str):
        raise web.HTTPError(400, "A project entrypoint path is required.")
    root = handler.contents_root
    project = project_root(root, path)
    # Apply the contents manager's read and hidden-file rules too.
    await contents_call(handler.contents_manager.get, path, content=False, type="file")
    handler.set_header("Cache-Control", "no-store")
    return project


class RunsHandler(ProjectAPIHandler):
    """The run history and jobs of a project, and starting a new job."""

    unavailable_message = "Materialization runs require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Materialization commits from Git plus this server's jobs for the project."""
        project = await self.project()
        # Git walks the history on disk, so it runs off the event loop.
        runs = await asyncio.to_thread(run_history, project)
        jobs = job_registry(self.settings).listing(contents_path(self.contents_root, project))
        self.finish({"runs": runs, "jobs": jobs})

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """Start `lc materialize` for the project named in the body; one job per project."""
        for action, resource in (("read", "contents"), ("execute", "lightcone")):
            if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, action, resource)):
                raise web.HTTPError(403, "Materialization is not authorized.")
        if os.name == "nt":
            raise web.HTTPError(501, "Materialization jobs require a POSIX Jupyter server.")
        body = self.get_json_body()
        if not isinstance(body, dict):
            raise web.HTTPError(400, "A JSON body with the project entrypoint is required.")
        targets = validate_targets(body.get("targets", []))
        refresh = body.get("refresh", False)
        if not isinstance(refresh, bool):
            raise web.HTTPError(400, "refresh must be a boolean.")
        project = await authorized_project(self, body.get("path"))
        registry = job_registry(self.settings)
        path = contents_path(self.contents_root, project)
        if registry.running(path) is not None:
            raise web.HTTPError(409, "A materialization is already running in this project.")
        job = registry.start(project, path, targets, refresh)
        self.set_status(202)
        self.finish(job.payload())


class RunHandler(ProjectAPIHandler):
    """One job of a project: its snapshot, and stopping it."""

    unavailable_message = "Materialization runs require local files"

    def _job(self, job_id: str, project: Path) -> Job:
        job = job_registry(self.settings).get(job_id, contents_path(self.contents_root, project))
        if job is None:
            raise web.HTTPError(404, "No such materialization job in this project.")
        return job

    @web.authenticated
    @authorized
    async def get(self, job_id):
        """The job as it stands; events are not replayed, so clients start from this."""
        project = await self.project()
        self.finish(self._job(job_id, project).payload())

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def delete(self, job_id):
        """Terminate the job's process group; a finished job is left as it is."""
        project = await self.project()
        job = self._job(job_id, project)
        await job_registry(self.settings).cancel(job)
        self.finish(job.payload())


def setup_runs_handlers(web_app) -> None:
    """Register under the server base URL, including JupyterHub prefixes; idempotent."""
    if web_app.settings.get(HANDLERS_SETTING):
        return
    web_app.settings[HANDLERS_SETTING] = True
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(api, "runs"), RunsHandler),
            (url_path_join(api, "runs", r"([0-9a-f\-]{36})"), RunHandler),
        ],
    )
