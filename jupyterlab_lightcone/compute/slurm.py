"""Clusters that are one Slurm job: a scheduler on the first node, a worker on each.

The job is submitted with `sbatch` from the Jupyter server's host, so it
outlives the server and ends at its time limit, when its scheduler has been
idle for the configured timeout, or on Stop. The scheduler binds the node's
Slurm name, as the engine's own allocation venue does, and writes its
connection file into the cluster directory on the shared home filesystem.
"""

from __future__ import annotations

import re
import shlex
import subprocess
import sys

from .backend import BackendError, PresetError, Status, integer, run_tool, word
from .records import ENCRYPTION_ENV, Record, read_scheduler_file, scheduler_argv, worker_arguments

JOB_SCRIPT = "job.sh"
JOB_NAME_PREFIX = "lightcone-"

_TIME = re.compile(r"(\d+-)?\d{1,3}(:\d{2}){0,2}")
"""Slurm's time formats: minutes, M:S, H:M:S, D-H, D-H:M, D-H:M:S."""
_NAME = re.compile(r"[A-Za-z0-9_.\-]{1,64}")
_CONSTRAINT = re.compile(r"[A-Za-z0-9_.\-&|,\[\]*]{1,128}")
_JOB = re.compile(r"\d+")
_STARTED = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

_ENDINGS = {
    "TIMEOUT": "reached its time limit",
    "CANCELLED": "was cancelled",
    "DEADLINE": "reached its deadline",
    "PREEMPTED": "was preempted",
    "NODE_FAIL": "lost a node",
    "OUT_OF_MEMORY": "ran out of memory",
    "FAILED": "failed",
    "BOOT_FAIL": "failed to start",
}
"""Why a job ended, by Slurm state; anything else simply ended."""


def seconds(text: str) -> int | None:
    """A Slurm duration (`M:S`, `H:M:S`, `D-H:M:S`) in seconds; None for anything else."""
    match = re.fullmatch(r"(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?", text.strip())
    if match is None:
        return None
    days, first, second, third = match.groups()
    if third is not None:
        hours, minutes, secs = int(first), int(second), int(third)
    elif second is not None and days is None:
        hours, minutes, secs = 0, int(first), int(second)
    elif second is not None:
        hours, minutes, secs = int(first), int(second), 0
    else:
        hours, minutes, secs = (int(first), 0, 0) if days is not None else (0, int(first), 0)
    return ((int(days or 0) * 24 + hours) * 60 + minutes) * 60 + secs


def _quote(argument: str) -> str:
    """Quote for bash, leaving `$host`-style expansions to the shell."""
    return f'"{argument}"' if "$" in argument else shlex.quote(argument)


def job_script(record: Record, spec: dict, interpreter: str, idle_timeout: int) -> str:
    """The batch script: directives from the preset, then the scheduler and one worker step."""
    directives = [
        f"--job-name={JOB_NAME_PREFIX}{record.id}",
        f"--nodes={spec['nodes']}",
        f"--time={spec['time']}",
        "--output=slurm-%j.out",
    ]
    for key in ("qos", "constraint", "account"):
        if spec.get(key):
            directives.append(f"--{key}={spec[key]}")
    scheduler = " ".join(_quote(a) for a in scheduler_argv(interpreter, record, "$host", idle_timeout))
    worker = " ".join(_quote(a) for a in [interpreter, *worker_arguments(record), "--nthreads", "$cpus"])
    environment = "\n".join(f"export {key}={value}" for key, value in ENCRYPTION_ENV.items())
    lines = [
        "#!/bin/bash",
        *(f"#SBATCH {directive}" for directive in directives),
        "",
        f"# Lightcone cluster {record.id}: a Dask scheduler on this node, one worker per node.",
        "set -u",
        environment,
        "# srun would read these as the worker step's CPUs per task; the step sets its own.",
        "unset SLURM_CPUS_PER_TASK SLURM_TRES_PER_TASK",
        'host="${SLURMD_NODENAME:-$(hostname)}"',
        'cpus="${SLURM_CPUS_ON_NODE:-$(nproc)}"',
        f"{scheduler} &",
        "scheduler=$!",
        'srun --overlap --ntasks="$SLURM_JOB_NUM_NODES" --ntasks-per-node=1 '
        f'--cpus-per-task="$cpus" {worker} &',
        "workers=$!",
        "# The cluster needs both halves: when either ends, the job ends.",
        "wait -n",
        'kill "$scheduler" "$workers" 2>/dev/null',
        "wait",
        "",
    ]
    return "\n".join(lines)


class SlurmBackend:
    """Clusters submitted as batch jobs to the Slurm controller this host uses."""

    name = "slurm"

    def __init__(self, idle_timeout: int, which):
        self.idle_timeout = idle_timeout
        self._which = which

    def available(self) -> bool:
        return all(self._which(tool) for tool in ("sbatch", "squeue", "scancel"))

    def validate(self, preset: dict) -> dict:
        time = preset.get("time", "1:00:00")
        if not isinstance(time, str) or _TIME.fullmatch(time) is None:
            raise PresetError("time must be a Slurm time limit such as 30, 2:00:00 or 1-00:00:00.")
        return {
            "nodes": integer(preset, "nodes", 1, 1, 10000),
            "time": time,
            "qos": word(preset, "qos", _NAME, "a Slurm QOS name"),
            "constraint": word(preset, "constraint", _CONSTRAINT, "a Slurm constraint such as cpu or gpu"),
            "account": word(preset, "account", _NAME, "a Slurm account name"),
        }

    async def start(self, record: Record, spec: dict) -> None:
        script = record.path(JOB_SCRIPT)
        script.write_text(job_script(record, spec, sys.executable, self.idle_timeout), encoding="utf-8")
        script.chmod(0o700)
        try:
            done = await run_tool(["sbatch", "--parsable", JOB_SCRIPT], cwd=record.directory)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BackendError(f"Could not run sbatch: {error}") from error
        job = done.stdout.strip().split(";")[0]
        if done.returncode != 0 or _JOB.fullmatch(job) is None:
            message = (done.stderr or done.stdout).strip() or f"exit code {done.returncode}"
            raise BackendError(f"Slurm refused the cluster: {message}")
        record.data["slurm"] = {"job": job, **{key: value for key, value in spec.items() if value is not None}}

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        if not records:
            return {}
        try:
            done = await run_tool(["squeue", "--me", "--noheader", "--format=%i|%T|%S|%L"])
        except (OSError, subprocess.TimeoutExpired):
            done = None
        if done is None or done.returncode != 0:
            return {record.id: Status("unknown") for record in records}
        jobs = {}
        for line in done.stdout.splitlines():
            fields = line.strip().split("|")
            if len(fields) == 4:
                jobs[fields[0]] = fields[1:]
        statuses = {}
        for record in records:
            job = record.section("slurm").get("job")
            if job not in jobs:
                statuses[record.id] = Status("gone", reason=await self._ending(job))
                continue
            state, started, left = jobs[job]
            if state == "PENDING":
                statuses[record.id] = Status(
                    "queued", start_estimate=started if _STARTED.fullmatch(started) else None
                )
            elif state in ("RUNNING", "CONFIGURING"):
                statuses[record.id] = Status(
                    "running" if read_scheduler_file(record) else "starting", time_left=seconds(left)
                )
            else:
                statuses[record.id] = Status("stopping")
        return statuses

    async def stop(self, record: Record) -> None:
        job = record.section("slurm").get("job")
        if not isinstance(job, str):
            return
        try:
            done = await run_tool(["scancel", job])
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BackendError(f"Could not run scancel: {error}") from error
        if done.returncode != 0:
            raise BackendError(f"Slurm refused to cancel job {job}: {done.stderr.strip()}")

    async def _ending(self, job) -> str:
        """Why a job left the queue, from accounting where the site keeps it."""
        if not isinstance(job, str) or not self._which("sacct"):
            return "ended"
        try:
            done = await run_tool(["sacct", "--noheader", "--parsable2", "--allocations", f"--jobs={job}", "--format=State"])
        except (OSError, subprocess.TimeoutExpired):
            return "ended"
        state = (done.stdout.strip().splitlines() or [""])[0].split(" ")[0]
        return _ENDINGS.get(state, "ended")
