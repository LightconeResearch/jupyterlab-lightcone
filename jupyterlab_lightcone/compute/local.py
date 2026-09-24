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

import psutil

from .backend import BackendError, Status, integer
from .records import (
    ENCRYPTION_ENV, SCHEDULER_FILE, Record, read_scheduler_file, remove,
    scheduler_argv, worker_arguments, write_record,
)

LOOPBACK = "127.0.0.1"
STOP_GRACE = 10
"""Seconds processes get to close after SIGTERM before their groups are killed."""


def _process(record: Record, key: str) -> psutil.Process | None:
    """Find a live process belonging to this record, never just a matching PID.

    Creation times survive server restarts and Dask's optional process-title
    changes. Older records have no creation time, so require the exact Dask
    module and scheduler file instead. Both must still be in this directory.
    """
    local = record.section("local")
    pid = local.get(key)
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    try:
        process = psutil.Process(pid)
        if process.status() == psutil.STATUS_ZOMBIE:
            return None
        started = local.get(f"{key}_started")
        if started is not None:
            if process.create_time() != started:
                return None
        else:
            command = process.cmdline()
            module = "dask_scheduler" if key == "pid" else "dask_worker"
            if command[1:3] != ["-m", f"distributed.cli.{module}"]:
                return None
            try:
                scheduler_file = command[command.index("--scheduler-file") + 1]
            except (ValueError, IndexError):
                return None
            if Path(scheduler_file) != record.path(SCHEDULER_FILE):
                return None
        if Path(process.cwd()) != record.directory.resolve() or not process.is_running():
            return None
        return process
    except psutil.NoSuchProcess:
        return None
    except psutil.AccessDenied as error:
        raise BackendError("Could not verify the local cluster's processes; its record has been kept.") from error


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
                    process = await asyncio.create_subprocess_exec(
                        *argv,
                        cwd=record.directory,
                        env=dict(os.environ, **ENCRYPTION_ENV),
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=log,
                        stderr=asyncio.subprocess.STDOUT,
                        start_new_session=True,
                    )
                processes.append(process)
                self._launched[record.id] = processes
                local = record.data.setdefault("local", {"host": socket.gethostname(), "threads": spec["threads"]})
                key = "pid" if name == "scheduler" else "worker"
                local[key] = process.pid
                local[f"{key}_started"] = psutil.Process(process.pid).create_time()
                # Persist each accepted handle before the next launch can fail.
                write_record(record)
        except BaseException as error:
            if processes:
                try:
                    await self.stop(record)
                except BackendError as cleanup_error:
                    error.add_note(str(cleanup_error))
            if isinstance(error, (OSError, psutil.Error)):
                raise BackendError(f"Could not start the local cluster: {error}") from error
            raise

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        here = socket.gethostname()
        statuses = {}
        for record in records:
            local = record.section("local")
            if local.get("host") != here:
                # Another host's processes cannot be asked about from here.
                statuses[record.id] = Status("unknown")
            else:
                try:
                    scheduler = _process(record, "pid")
                    worker = _process(record, "worker")
                except BackendError:
                    statuses[record.id] = Status("unknown")
                    continue
                if scheduler is None:
                    # Keep the handle while a worker still holds resources.
                    statuses[record.id] = Status("stopping" if worker else "gone", reason="stopped")
                else:
                    statuses[record.id] = Status("starting" if read_scheduler_file(record) is None else "running")
        return statuses

    async def stop(self, record: Record) -> None:
        if record.section("local").get("host") != socket.gethostname():
            raise BackendError("Stop this local cluster from the host that started it.")
        for signum in (signal.SIGTERM, signal.SIGKILL):
            _signal_groups(record, signum)
            loop = asyncio.get_running_loop()
            deadline = loop.time() + STOP_GRACE
            while any(_process(record, key) for key in ("pid", "worker")):
                if loop.time() >= deadline:
                    break
                await asyncio.sleep(0.2)
            else:
                break
        if any(_process(record, key) for key in ("pid", "worker")):
            raise BackendError("The local cluster has not stopped; its record has been kept.")
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


def _signal_groups(record: Record, signum: int) -> None:
    """Recheck ownership before each signal, including escalation to SIGKILL."""
    for key in ("pid", "worker"):
        process = _process(record, key)
        if process is None:
            continue
        try:
            if os.getpgid(process.pid) != process.pid:
                raise BackendError("The local cluster's process group changed; its record has been kept.")
            if process.is_running():
                os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass
        except PermissionError as error:
            raise BackendError("Could not stop the local cluster's processes; its record has been kept.") from error
