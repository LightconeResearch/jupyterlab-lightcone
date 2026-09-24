"""What every cluster backend provides, and the checks their presets share."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
import re
import subprocess
from typing import Protocol

from .records import Record

LIVE_STATES = ("queued", "starting", "running")
"""States in which a cluster holds, or is about to hold, resources."""

TOOL_TIMEOUT = 30
"""Seconds a scheduler command (sbatch, squeue, scancel, sacct) may take."""


class PresetError(ValueError):
    """A preset field the backend cannot use; the message names the field."""


@dataclass
class Status:
    """A cluster as its backend reports it right now.

    `state` is one of `queued`, `starting`, `running`, `stopping`, `gone`, or
    `unknown` when the backend could not be asked: an unknown cluster is never
    forgotten, since a scheduler outage must not orphan a running job.
    """

    state: str
    time_left: int | None = None
    """Seconds before the backend ends the cluster (a Slurm time limit)."""
    start_estimate: str | None = None
    """When a queued cluster is expected to start, ISO 8601, if the backend says."""
    reason: str | None = None
    """Why a gone cluster ended, in words that follow "Your cluster …"."""
    dashboard: str | None = None
    """A dashboard link the backend already publishes (Dask Gateway)."""


class Backend(Protocol):
    """Starts, reports on and stops one kind of cluster."""

    name: str

    def available(self) -> bool:
        """Whether this server can create clusters of this kind."""

    def validate(self, preset: dict) -> dict:
        """The backend's own fields of a preset, checked; raises PresetError."""

    async def start(self, record: Record, spec: dict) -> None:
        """Submit or launch the cluster and store its handle in the record."""

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        """The status of each record of this backend, by cluster id."""

    async def stop(self, record: Record) -> None:
        """Ask the backend to end the cluster; its status then reports it."""


def integer(preset: dict, key: str, default: int | None, low: int, high: int) -> int | None:
    value = preset.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise PresetError(f"{key} must be a whole number from {low} to {high}.")
    return value


def number(preset: dict, key: str, low: float, high: float) -> float | None:
    value = preset.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float) or not low <= value <= high:
        raise PresetError(f"{key} must be a number from {low:g} to {high:g}.")
    return value


def word(preset: dict, key: str, pattern: re.Pattern[str], explanation: str) -> str | None:
    """An optional short token copied into a scheduler directive; never free text."""
    value = preset.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise PresetError(f"{key} must be {explanation}.")
    return value


async def run_tool(argv: list[str], cwd=None, timeout: float = TOOL_TIMEOUT) -> subprocess.CompletedProcess:
    """Run a scheduler command off the event loop; never through a shell.

    Raises OSError when the command cannot start and subprocess.TimeoutExpired
    when it hangs, so callers tell "could not ask" apart from a refusal.
    """
    return await asyncio.to_thread(
        subprocess.run,
        argv,
        cwd=cwd,
        env=dict(os.environ),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class BackendError(Exception):
    """A backend refused an action; the message is for the user."""
