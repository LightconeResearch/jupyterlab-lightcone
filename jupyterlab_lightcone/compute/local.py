"""Clusters on this host: a scheduler and one worker, each in a session of its own.

The scheduler listens on the loopback interface only, and both processes run
this server's interpreter. They outlive a crash of the Jupyter server until
the scheduler's idle timeout ends it (and the worker's death timeout ends the
worker); a clean shutdown stops them.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import signal
import socket
import sys

from .backend import BackendError, Status, integer
from .records import ENCRYPTION_ENV, Record, read_scheduler_file, remove, scheduler_argv, worker_arguments

LOOPBACK = "127.0.0.1"
STOP_GRACE = 10
"""Seconds the scheduler gets to close after SIGTERM before the group is killed."""


def _scheduler_alive(pid: int) -> bool:
    """Whether the scheduler this record started is still running.

    Where /proc exists, a reused process id is told apart from the scheduler
    by its command line.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return True
    return b"distributed.cli.dask_scheduler" in command


class LocalBackend:
    """Clusters made of processes on the Jupyter server's own host."""

    name = "local"

    def __init__(self, idle_timeout: int):
        self.idle_timeout = idle_timeout
        self._launched: dict[str, list[asyncio.subprocess.Process]] = {}

    def available(self) -> bool:
        return os.name == "posix"

    def validate(self, preset: dict) -> dict:
        return {"threads": integer(preset, "threads", os.cpu_count() or 1, 1, 4096)}

    async def start(self, record: Record, spec: dict) -> None:
        commands = {
            "scheduler": scheduler_argv(sys.executable, record, LOOPBACK, self.idle_timeout),
            "worker": [sys.executable, *worker_arguments(record), "--nthreads", str(spec["threads"])],
        }
        processes: list[asyncio.subprocess.Process] = []
        try:
            for name, argv in commands.items():
                with open(record.path(f"{name}.log"), "ab") as log:
                    processes.append(
                        await asyncio.create_subprocess_exec(
                            *argv,
                            cwd=record.directory,
                            env=dict(os.environ, **ENCRYPTION_ENV),
                            stdin=asyncio.subprocess.DEVNULL,
                            stdout=log,
                            stderr=asyncio.subprocess.STDOUT,
                            start_new_session=True,
                        )
                    )
        except OSError as error:
            for process in processes:
                os.killpg(process.pid, signal.SIGKILL)
            raise BackendError(f"Could not start the local cluster: {error}") from error
        scheduler, worker = processes
        self._launched[record.id] = processes
        record.data["local"] = {
            "host": socket.gethostname(),
            "pid": scheduler.pid,
            "worker": worker.pid,
            "threads": spec["threads"],
        }

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        here = socket.gethostname()
        statuses = {}
        for record in records:
            local = record.section("local")
            pid = local.get("pid")
            if local.get("host", here) != here:
                # Another host's processes cannot be asked about from here.
                statuses[record.id] = Status("unknown")
            elif not isinstance(pid, int) or not _scheduler_alive(pid):
                statuses[record.id] = Status("gone", reason="stopped")
            elif read_scheduler_file(record) is None:
                statuses[record.id] = Status("starting")
            else:
                statuses[record.id] = Status("running")
        return statuses

    async def stop(self, record: Record) -> None:
        local = record.section("local")
        groups = [pid for pid in (local.get("pid"), local.get("worker")) if isinstance(pid, int)]
        _signal_groups(groups, signal.SIGTERM)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STOP_GRACE
        while groups and _scheduler_alive(groups[0]) and loop.time() < deadline:
            await asyncio.sleep(0.2)
        _signal_groups(groups, signal.SIGKILL)
        # Reap the children this server launched, so none lingers as a zombie.
        for process in self._launched.pop(record.id, []):
            try:
                await asyncio.wait_for(process.wait(), STOP_GRACE)
            except asyncio.TimeoutError:
                pass
        remove(record)

    async def close(self, records: list[Record]) -> None:
        """Stop the clusters this server launched, as Jupyter shuts down."""
        mine = [record for record in records if record.id in self._launched]
        await asyncio.gather(*(self.stop(record) for record in mine), return_exceptions=True)


def _signal_groups(groups: list[int], signum: int) -> None:
    """Signal each process group; one already gone is simply skipped."""
    for pid in groups:
        try:
            os.killpg(pid, signum)
        except (ProcessLookupError, PermissionError):
            pass
