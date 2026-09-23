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

from .project_routes import ProjectAPIHandler
from .sessions import project_contents_path

JOB_SCHEMA_ID = "https://events.lightcone.dev/jupyterlab_lightcone/job/v1"
JOB_SCHEMA_PATH = Path(__file__).parent / "event_schemas" / "job.yaml"
JOBS_SETTING = "lightcone_jobs"
"""The web application setting holding this server's `JobRegistry`."""
HANDLERS_SETTING = "lightcone_runs_handlers"

MAX_RUNS = 200
MAX_JOBS = 20
MAX_LINES = 200
MAX_LINE_CHARS = 4096
"""A longer line is shown cut, so a job's lines and events stay small whatever a recipe prints."""
LINE_CUT = " …"
MAX_REPORT_CHARS = 1 << 20
"""How much of the end of stdout a job keeps to find the report the engine prints last."""
MAX_REPORT_ATTEMPTS = 8
MAX_TARGETS = 100
KILL_GRACE_SECONDS = 10
DRAIN_SECONDS = 5
"""How long a job waits for pipes that outlive the engine before reaping what holds them."""
GIT_TIMEOUT = 30
RESULTS_DIRECTORY = "results"
"""Where every materialization writes its output and manifest, relative to the project."""

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
    """The project's materialization commits, newest first; empty outside Git.

    Only commits that touch the project's own `results/` count, since every
    materialization commits its output and manifest there. The repository may
    hold other projects, or be a larger work tree the engine adopted around
    this one, and their runs are not this project's. `--full-history` keeps
    runs that history simplification would hide behind a merge.
    """
    try:
        result = subprocess.run(
            [
                "git",
                "log",
                f"--max-count={limit}",
                "--full-history",
                "--format=%H%x1f%cI%x1f%s%x1f%B%x1e",
                "--grep=^\\[DATALAD RUNCMD\\]",
                "--",
                RESULTS_DIRECTORY,
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


def is_report(value) -> bool:
    """Whether a JSON value carries the engine report's `ok` and `up_to_date` flags."""
    return (
        isinstance(value, dict)
        and isinstance(value.get("ok"), bool)
        and isinstance(value.get("up_to_date"), bool)
    )


def parse_report(text: str) -> dict | None:
    """The report `lc materialize --json` prints as the last thing on stdout.

    Recipes write to the same stdout, so only a JSON object that starts a
    line, runs to the end of the output and carries the report's flags
    counts: an engine that stopped before reporting must not lend a recipe's
    own JSON the report's authority.

    Candidates are tried from the end, a bounded number of times. A raw
    newline never occurs inside a JSON string, so a line-start `{` inside a
    document always opens a nested value that decodes on its own: once one
    fails to decode, no earlier line can start a document reaching the end,
    and the search stops. Deep nesting fails too, as a `RecursionError`.
    """
    body = text.rstrip()
    if not body.endswith("}"):
        return None
    decoder = json.JSONDecoder()
    starts = [match.start() for match in JSON_LINE.finditer(body)]
    for start in reversed(starts[-MAX_REPORT_ATTEMPTS:]):
        try:
            value, end = decoder.raw_decode(body, start)
        except (ValueError, RecursionError):
            return None
        if end == len(body):
            return value if is_report(value) else None
    return None


def display_line(text: str) -> str:
    """One line as a terminal leaves it visible, cut to `MAX_LINE_CHARS`.

    A carriage return rewrites the line from its start, so a progress bar
    redrawn in place shows its final state; escape sequences only style it.
    """
    text = text.rstrip("\r")
    text = ANSI_ESCAPE.sub("", text[text.rfind("\r") + 1:])
    return text if len(text) <= MAX_LINE_CHARS else text[:MAX_LINE_CHARS] + LINE_CUT


class LineSplitter:
    """Cut a stream's decoded text into display lines as it arrives, in bounded memory.

    A chunk may end mid-line, so the unfinished line is held for the next
    one. Only what follows its last carriage return is held, as a terminal
    would have overwritten the rest, so a progress bar redrawn for hours
    stays one short line. A line still longer than `MAX_LINE_CHARS` is shown
    cut as soon as it gets that long, and the rest of it is dropped.
    """

    def __init__(self) -> None:
        self.pending = ""
        self.dropping = False

    def feed(self, text: str) -> list[str]:
        """The display lines `text` completes; its unfinished last line is held."""
        lines = []
        *complete, rest = text.split("\n")
        for part in complete:
            if not self.dropping:
                lines.append(display_line(self.pending + part))
            self.pending = ""
            self.dropping = False
        if not self.dropping:
            pending = self.pending + rest
            # A trailing carriage return may open a CRLF, so it is kept.
            pending = pending[pending.rfind("\r", 0, len(pending) - 1) + 1:]
            if len(pending) > MAX_LINE_CHARS:
                lines.append(display_line(pending))
                pending = ""
                self.dropping = True
            self.pending = pending
        return lines

    def close(self) -> list[str]:
        """The unfinished last line, once the stream has ended."""
        line, self.pending = self.pending, ""
        return [display_line(line)] if line.rstrip("\r") else []


class OutputTail:
    """The last `limit` characters of a stream, kept as chunks so appending stays cheap."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.chunks: deque[str] = deque()
        self.size = 0

    def append(self, text: str) -> None:
        """Add text, forgetting the oldest chunks once they lie wholly before the tail."""
        if not text:
            return
        self.chunks.append(text)
        self.size += len(text)
        while self.size - len(self.chunks[0]) >= self.limit:
            self.size -= len(self.chunks.popleft())

    def text(self) -> str:
        """The tail itself, at most `limit` characters."""
        return "".join(self.chunks)[-self.limit:]

    def clear(self) -> None:
        """Forget everything."""
        self.chunks.clear()
        self.size = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class Job:
    """One `lc materialize` run started from the UI and its bounded output."""

    id: str
    project: str
    """The project directory's Contents path, as the browser named it when starting the job."""
    directory: Path
    """The resolved project directory the engine runs in, which identifies the project."""
    targets: list[str]
    refresh: bool
    started: str
    state: str = "running"
    finished: str | None = None
    exit: int | None = None
    lines: deque = field(default_factory=lambda: deque(maxlen=MAX_LINES))
    report: dict | None = None
    stdout: OutputTail = field(default_factory=lambda: OutputTail(MAX_REPORT_CHARS))
    """The end of stdout, where the report is; dropped once the job finished."""
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
    """This server's materialization jobs, in memory, supervised as process groups.

    Jobs are found by their resolved project directory, so every path that
    reaches a project, through a symlink or not, sees the same jobs and
    shares its limit of one running job.
    """

    def __init__(self, log, event_logger=None):
        self.jobs: dict[str, Job] = {}
        self.log = log
        self.event_logger = event_logger
        self.grace = KILL_GRACE_SECONDS

    def listing(self, directory: Path) -> list[dict]:
        """The project's jobs in every state, newest first, capped."""
        jobs = [job for job in reversed(self.jobs.values()) if job.directory == directory]
        return [job.payload() for job in jobs[:MAX_JOBS]]

    def running(self, directory: Path) -> Job | None:
        """The project's running job, if any: there is at most one."""
        return next((job for job in self.jobs.values() if job.directory == directory and job.state == "running"), None)

    def get(self, job_id: str, directory: Path) -> Job | None:
        """A job by id, only within the project the request was authorized for."""
        job = self.jobs.get(job_id)
        return job if job is not None and job.directory == directory else None

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
        self._prune(directory)
        job.task = asyncio.create_task(self._run(job))
        return job

    def _prune(self, directory: Path) -> None:
        """Forget the oldest finished jobs of a project beyond the listing cap."""
        finished = [job for job in self.jobs.values() if job.directory == directory and job.state != "running"]
        for job in finished[: max(0, len(finished) - MAX_JOBS)]:
            del self.jobs[job.id]

    async def cancel(self, job: Job, grace: float | None = None) -> None:
        """Terminate a running job and wait for its record to be final.

        An engine that has already exited keeps its outcome, since what it
        committed stands: only descendants still holding its pipes are
        stopped, so that the record becomes final sooner.
        """
        if job.state != "running":
            return
        process = job.process
        if process is not None and process.returncode is not None:
            _kill_group(process)
        else:
            job.state = "cancelled"
            self.log.info("Cancelling Lightcone materialization %s in %s", job.id, job.directory)
            if process is not None:
                await _terminate(process, self.grace if grace is None else grace)
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
                self._record(job, display_line(f"Could not start the Lightcone engine: {error}"))
                return
            if job.state != "running":
                # Cancelled while spawning: nothing must run.
                await _terminate(job.process, 0)
            else:
                self._emit(job, None)
            readers = [
                asyncio.create_task(self._read(job, job.process.stdout, True)),
                asyncio.create_task(self._read(job, job.process.stderr, False)),
            ]
            await _exited(job.process)
            # The engine's last output may still be in the pipes, which grandchildren
            # can hold open: give the readers a moment, then reap those.
            await asyncio.wait(readers, timeout=DRAIN_SECONDS)
            _kill_group(job.process)
            # Recipes share the engine's stdout; however bounded, the search for
            # its report stays off the event loop.
            job.report = await asyncio.to_thread(parse_report, job.stdout.text())
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
        if job.state == "running":
            job.state = "succeeded" if job.exit == 0 else "failed"
        job.finished = _now()
        # The report has been read from it; a finished job keeps only its last lines.
        job.stdout.clear()
        self.log.info("Lightcone materialization %s %s (exit %s)", job.id, job.state, job.exit)
        self._emit(job, None)

    async def _read(self, job: Job, stream, is_stdout: bool) -> None:
        """Turn a pipe into lines as they arrive; a chunk may end mid-character or mid-line.

        Stdout is also kept verbatim, up to its bounded tail, for the report.
        """
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        splitter = LineSplitter()
        while True:
            chunk = await stream.read(4096)
            text = decoder.decode(chunk, final=not chunk)
            if is_stdout:
                job.stdout.append(text)
            lines = splitter.feed(text)
            if not chunk:
                lines.extend(splitter.close())
            for line in lines:
                self._record(job, line)
            if not chunk:
                return

    def _record(self, job: Job, line: str) -> None:
        """Keep a display line in the bounded log and tell listeners."""
        job.lines.append(line)
        self._emit(job, line)

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
        jobs = job_registry(self.settings).listing(project)
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
        entrypoint = body.get("path")
        project = await self.project_named(entrypoint)
        registry = job_registry(self.settings)
        if registry.running(project) is not None:
            raise web.HTTPError(409, "A materialization is already running in this project.")
        # Jobs name their project as the browser does, symlinks included.
        job = registry.start(project, project_contents_path(entrypoint), targets, refresh)
        self.set_status(202)
        self.finish(job.payload())


class RunHandler(ProjectAPIHandler):
    """One job of a project: its snapshot, and stopping it."""

    unavailable_message = "Materialization runs require local files"

    def _job(self, job_id: str, project: Path) -> Job:
        job = job_registry(self.settings).get(job_id, project)
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
