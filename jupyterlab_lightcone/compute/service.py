"""What the Compute section lists and does: where runs can go, and which one they will.

The registry is the source of truth for how to reach a cluster; its backend
is the source of truth for whether it still exists. Every listing joins the
two: a record whose cluster is gone is removed (and reported once as ended),
while a record whose backend cannot be asked is kept, since an outage must
never orphan a running cluster. The target marked active is the one
`lc materialize` will use, by the selection rule the design document states.
"""

from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import socket
import sys
import time
from urllib.parse import urlparse

from jupyter_server.utils import url_path_join

from .backend import LIVE_STATES, Backend, BackendError, PresetError, Status
from .gateway import server_image
from .records import (
    FORMAT,
    Record,
    make_directory,
    new_cluster_id,
    package_version,
    read_records,
    read_scheduler_file,
    registry_root,
    remove,
    security,
    utc_now,
    worker_environment,
    write_record,
    write_tls,
)

SURVEY_SECONDS = 2.0
"""How long one look at the backends answers every listing, across browser tabs."""
ENDED_SECONDS = 900
"""How long an ended cluster stays in listings, so every open tab can report it."""
LOAD_TIMEOUT = 3.0
"""Seconds a scheduler may take to say how busy it is; a slow one shows no load."""
LABEL_LIMIT = 80
LAUNCH_GRACE = 120
"""Seconds a record may wait for its backend handle before it is called dead."""

BACKEND_NAMES = {"local": "local", "slurm": "Slurm", "gateway": "Dask Gateway"}


class ConflictError(Exception):
    """A second cluster for the same backend and environment was asked for."""


def engine_attaches() -> bool:
    """Whether the installed engine reads cluster records of this format."""
    from lightcone.engine import venue

    return getattr(venue, "CLUSTER_RECORD_FORMAT", None) == FORMAT


def _containerized(project: Path | None) -> bool:
    if project is None:
        return False
    from lightcone.engine import project as engine_project

    try:
        return engine_project.mode(project) == "containerized"
    except Exception:
        return False


def host_target(project: Path | None) -> dict:
    """This host as a place runs can go: always listed, active when no cluster is."""
    from lightcone.engine import container, venue
    from lightcone.engine.project import ProjectError

    target = {
        "id": "host",
        "kind": "host",
        "backend": None,
        "variant": "machine",
        "state": "ready",
        "active": False,
        "other": None,
        "problem": None,
        "size": {"threads": os.cpu_count(), "nodes": None, "workers": None},
    }
    if "SLURM_JOB_ID" in os.environ:
        target["variant"] = "allocation"
        try:
            target["size"]["nodes"] = venue.allocation_nodes()
        except ProjectError:
            pass
        return target
    try:
        venue.require_compute_node()
    except ProjectError:
        target.update(
            variant="login",
            state="check-only",
            problem={"code": "login-node", "message": "Runs need compute nodes."},
        )
        return target
    if os.environ.get("JUPYTERHUB_USER"):
        target["variant"] = "server"
    if _containerized(project) and not container.runtime_hint():
        target.update(
            state="check-only",
            problem={
                "code": "container-runtime",
                "message": "This project runs in its own image, and no container runtime is available here.",
            },
        )
    return target


def dashboard_url(record: Record, scheduler: dict, base_url: str) -> str | None:
    """The scheduler's dashboard through jupyter-server-proxy, when both are there to serve it."""
    port = (scheduler.get("services") or {}).get("dashboard")
    if not isinstance(port, int) or not all(
        importlib.util.find_spec(module) for module in ("bokeh", "jupyter_server_proxy")
    ):
        return None
    if record.backend == "local":
        return url_path_join(base_url, "proxy", str(port), "status")
    host = urlparse(scheduler["address"]).hostname
    return url_path_join(base_url, "proxy", f"{host}:{port}", "status")


async def scheduler_load(record: Record, scheduler: dict) -> dict | None:
    """Workers, threads and busy threads, from the scheduler's own identity call."""
    from distributed.core import rpc

    try:
        remote = rpc(
            scheduler["address"],
            connection_args=security(record).get_connection_args("client"),
            timeout=LOAD_TIMEOUT,
        )
    except Exception:
        return None
    try:
        identity = await asyncio.wait_for(remote.identity(), LOAD_TIMEOUT)
    except Exception:
        return None
    finally:
        await remote.close_rpc()
    workers = identity.get("workers") or {}
    busy = sum(
        int(((worker.get("metrics") or {}).get("task_counts") or {}).get("executing", 0))
        for worker in workers.values()
    )
    return {
        "workers": int(identity.get("n_workers", len(workers))),
        "threads": int(identity.get("total_threads", 0)),
        "busy": busy,
    }


class ComputeService:
    """The server's view of its clusters, shared by every request and browser tab."""

    def __init__(self, backends: list[Backend], base_url: str, idle_timeout: int, root: Path | None = None):
        self.backends = {backend.name: backend for backend in backends}
        self.base_url = base_url
        self.idle_timeout = idle_timeout
        self._root = root
        self._stopping: set[str] = set()
        self._ended: deque[dict] = deque(maxlen=20)
        self._lock = asyncio.Lock()
        self._survey_at = 0.0
        self._survey: list[tuple[Record, Status, dict | None, dict | None]] = []

    @property
    def root(self) -> Path:
        return self._root or registry_root()

    def invalidate(self) -> None:
        self._survey_at = 0.0

    async def listing(self, project: Path | None) -> dict:
        """Every place runs can go, the one they will, and clusters that just ended."""
        survey = await self._look()
        host = await asyncio.to_thread(host_target, project)
        containerized = await asyncio.to_thread(_containerized, project)
        attaches = await asyncio.to_thread(engine_attaches)
        clusters = [self._target(*entry, containerized) for entry in survey]
        in_allocation = "SLURM_JOB_ID" in os.environ
        candidates = [t for t in clusters if t["other"] is None and t["state"] in LIVE_STATES]
        if attaches and not in_allocation and len(candidates) == 1:
            candidates[0]["active"] = True
        else:
            host["active"] = True
            if attaches and not in_allocation and len(candidates) > 1:
                host["problem"] = {
                    "code": "several-clusters",
                    "message": "Several clusters could run this project; stop all but one.",
                }
        now = time.time()
        return {
            "format": FORMAT,
            "attaches": attaches,
            "lightcone": package_version("lightcone-cli"),
            "idleTimeout": self.idle_timeout,
            "backends": self._creatable(host),
            "targets": [host, *clusters],
            "ended": [
                {key: value for key, value in entry.items() if key != "time"}
                for entry in self._ended
                if now - entry["time"] < ENDED_SECONDS
            ],
        }

    def _creatable(self, host: dict) -> list[str]:
        """Backends that can start a cluster here; never processes on a login node."""
        return [
            name
            for name, backend in self.backends.items()
            if backend.available() and not (name == "local" and host["variant"] == "login")
        ]

    async def create(self, preset, project: Path | None) -> dict:
        """Start a cluster from a preset; one per backend and environment at a time."""
        if not isinstance(preset, dict):
            raise PresetError("A preset object is required.")
        name = preset.get("backend")
        backend = self.backends.get(name) if isinstance(name, str) else None
        host = await asyncio.to_thread(host_target, project)
        if backend is None or name not in self._creatable(host):
            raise PresetError(f"This server cannot start {name!r} clusters.")
        spec = backend.validate(preset)
        label = preset.get("label")
        if not isinstance(label, str) or not label.strip() or len(label) > LABEL_LIMIT or not label.isprintable():
            raise PresetError(f"label must be a name of 1 to {LABEL_LIMIT} printable characters.")
        for target in (await self.listing(project))["targets"]:
            if (
                target["backend"] == name
                and target["other"] is None
                and target["state"] in LIVE_STATES
            ):
                raise ConflictError(
                    f"A {BACKEND_NAMES[name]} cluster is already running for this environment; "
                    "stop it before starting another."
                )
        cluster_id = new_cluster_id()
        directory = await asyncio.to_thread(make_directory, self.root, cluster_id)
        hosted = name != "gateway"
        record = Record(
            directory,
            {
                "format": FORMAT,
                "id": cluster_id,
                "backend": name,
                "label": label.strip(),
                "created": utc_now(),
                "host": socket.gethostname(),
                "tls": await asyncio.to_thread(write_tls, directory) if hosted else None,
                "workers": worker_environment(interpreter=sys.executable if hosted else None),
            },
        )
        try:
            # Written before anything starts, so no cluster ever runs unrecorded.
            await asyncio.to_thread(write_record, record)
            await backend.start(record, spec)
            await asyncio.to_thread(write_record, record)
        except BaseException:
            await asyncio.to_thread(remove, record)
            raise
        self.invalidate()
        listing = await self.listing(project)
        return next(target for target in listing["targets"] if target["id"] == cluster_id)

    async def stop(self, cluster_id: str) -> None:
        """Ask the cluster's backend to end it; the record goes once the backend agrees."""
        record = next((r for r in await asyncio.to_thread(read_records, self.root) if r.id == cluster_id), None)
        backend = self.backends.get(record.backend) if record else None
        if record is None or backend is None:
            raise KeyError(cluster_id)
        self._stopping.add(cluster_id)
        try:
            await backend.stop(record)
        except BackendError:
            self._stopping.discard(cluster_id)
            raise
        if not record.directory.exists():
            # Stopped and forgotten at once (local processes): nothing to wait for.
            self._stopping.discard(cluster_id)
        self.invalidate()

    async def close(self) -> None:
        """Stop the local clusters this server launched; Jupyter is shutting down."""
        local = self.backends.get("local")
        if local is not None:
            records = await asyncio.to_thread(read_records, self.root)
            await local.close([record for record in records if record.backend == "local"])

    async def _look(self):
        """Join records with their backends' statuses, at most once per SURVEY_SECONDS."""
        async with self._lock:
            if time.monotonic() - self._survey_at < SURVEY_SECONDS:
                return self._survey
            records = [r for r in await asyncio.to_thread(read_records, self.root) if r.backend in self.backends]
            # A record is written before its backend is asked, so one without a
            # handle yet may be a start in progress: never ask the backend about it.
            statuses = {record.id: _unlaunched(record) for record in records if not record.section(record.backend)}
            groups: dict[str, list[Record]] = {}
            for record in records:
                if record.id not in statuses:
                    groups.setdefault(record.backend, []).append(record)
            results = await asyncio.gather(
                *(self.backends[name].statuses(group) for name, group in groups.items())
            )
            statuses.update({key: value for result in results for key, value in result.items()})
            survey = []
            for record in records:
                status = statuses.get(record.id, Status("unknown"))
                if status.state == "gone":
                    await self._forget(record, status)
                    continue
                if record.id in self._stopping:
                    status.state = "stopping"
                scheduler = read_scheduler_file(record) if record.data.get("tls") else None
                survey.append((record, status, scheduler))
            loads = await asyncio.gather(
                *(
                    scheduler_load(record, scheduler) if scheduler and status.state == "running" else _nothing()
                    for record, status, scheduler in survey
                )
            )
            self._survey = [(r, s, sched, load) for (r, s, sched), load in zip(survey, loads)]
            self._survey_at = time.monotonic()
            return self._survey

    async def _forget(self, record: Record, status: Status) -> None:
        """Remove a gone cluster's record; report it unless the user stopped it."""
        if record.id in self._stopping:
            self._stopping.discard(record.id)
        else:
            self._ended.append(
                {
                    "id": record.id,
                    "backend": record.backend,
                    "label": record.data.get("label"),
                    "reason": status.reason or "ended",
                    "at": utc_now(),
                    "time": time.time(),
                }
            )
        await asyncio.to_thread(remove, record)

    def _target(self, record: Record, status: Status, scheduler, load, containerized: bool) -> dict:
        data = record.data
        workers = data.get("workers") or {}
        other = None
        if status.state == "unknown" and record.backend == "local":
            other = f"on {record.section('local').get('host')}"
        elif status.state == "unknown" and record.backend == "gateway":
            other = "another gateway"
        elif record.backend == "gateway" and (containerized or workers.get("image") != server_image()):
            other = "another image"
        problem = None
        server_lightcone = package_version("lightcone-cli")
        if other is None and workers.get("lightcone") != server_lightcone:
            problem = {
                "code": "version",
                "message": f"Workers run lightcone-cli {workers.get('lightcone')}; this server has {server_lightcone}.",
            }
        slurm = record.section("slurm")
        gateway = record.section("gateway")
        details = {
            "local": [f"On {record.section('local').get('host')}", f"Stops after {self.idle_timeout // 60} min idle"],
            "slurm": [f"Job {slurm.get('job')}", *(slurm[k] for k in ("qos", "constraint", "account") if slurm.get(k))],
            "gateway": [f"Dask Gateway · {gateway.get('name')}", f"Adapts 1–{gateway.get('workers')} workers"],
        }.get(record.backend, [])
        return {
            "id": record.id,
            "kind": "cluster",
            "backend": record.backend,
            "label": data.get("label"),
            "state": status.state,
            "active": False,
            "other": other,
            "problem": problem,
            "size": {
                "threads": load["threads"] if load else record.section("local").get("threads"),
                "nodes": slurm.get("nodes"),
                "workers": load["workers"] if load else gateway.get("workers"),
            },
            "load": load,
            "timeLeft": status.time_left,
            "startEstimate": status.start_estimate,
            "dashboard": status.dashboard or (dashboard_url(record, scheduler, self.base_url) if scheduler else None),
            "details": details,
            "created": data.get("created"),
        }


async def _nothing():
    return None


def _unlaunched(record: Record) -> Status:
    """A record its backend has not accepted: starting for a while, then dead."""
    try:
        created = datetime.strptime(record.data["created"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return Status("gone", reason="did not start")
    age = (datetime.now(timezone.utc) - created).total_seconds()
    return Status("starting") if age < LAUNCH_GRACE else Status("gone", reason="did not start")
