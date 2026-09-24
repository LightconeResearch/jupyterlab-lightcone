"""Clusters on Dask Gateway, as a JupyterHub deployment on Kubernetes offers it.

The gateway keeps the cluster, its TLS credentials and its lifetime (its own
idle timeout); the record only names it. Workers run this server's image, so
they run the same engine as this server. Clusters are adaptive between one
worker and the preset's maximum: the one worker is what the engine checks its
version against when it attaches.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import importlib.util
import os

from .backend import BackendError, Status, integer, number
from .records import Record

MARKER = "LIGHTCONE_CLUSTER"
"""The environment variable, set in every scheduler and worker pod, naming the record."""

_STATES = {"PENDING": "starting", "RUNNING": "running", "STOPPING": "stopping"}
_ENDINGS = {"STOPPED": "was stopped", "FAILED": "failed"}

OPTION_FIELDS = (("cores", "worker_cores"), ("memory", "worker_memory"))
"""Preset fields and the cluster options of a standard daskhub deployment they set."""


def server_image() -> str | None:
    """The image this Jupyter server runs, as KubeSpawner announces it."""
    return os.environ.get("JUPYTER_IMAGE_SPEC") or os.environ.get("JUPYTER_IMAGE") or None


def _default_gateway():
    from dask_gateway import Gateway

    return Gateway(asynchronous=True)


class GatewayBackend:
    """Clusters the user's Dask Gateway starts and culls, authenticated by JupyterHub."""

    name = "gateway"

    def __init__(self, factory=_default_gateway):
        self._factory = factory

    def available(self) -> bool:
        if importlib.util.find_spec("dask_gateway") is None:
            return False
        import dask.config

        return bool(dask.config.get("gateway.address", None))

    def validate(self, preset: dict) -> dict:
        return {
            "workers": integer(preset, "workers", 2, 1, 1000),
            "cores": number(preset, "cores", 0.1, 1024),
            "memory": number(preset, "memory", 0.1, 4096),
        }

    @asynccontextmanager
    async def _open(self):
        gateway = self._factory()
        try:
            yield gateway
        finally:
            await gateway.close()

    async def start(self, record: Record, spec: dict) -> None:
        image = server_image()
        async with self._open() as gateway:
            options = await gateway.cluster_options()
            try:
                if image and "image" in options:
                    options["image"] = image
                for field, option in OPTION_FIELDS:
                    if spec[field] is None:
                        continue
                    if option not in options:
                        raise BackendError(f"This gateway has no {option} option, which the preset's {field} sets.")
                    options[option] = spec[field]
                if "environment" in options:
                    options["environment"] = {**(options["environment"] or {}), MARKER: record.id}
            except (ValueError, TypeError) as error:
                raise BackendError(f"The gateway rejected the preset: {error}") from error
            name = await gateway.submit(options)
            await gateway.adapt_cluster(name, minimum=1, maximum=spec["workers"])
            address = gateway.address
        record.data["gateway"] = {
            "name": name,
            "address": address,
            **{key: value for key, value in spec.items() if value is not None},
        }
        record.data["workers"]["image"] = options["image"] if "image" in options else image

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        if not records:
            return {}
        try:
            async with self._open() as gateway:
                address = gateway.address
                reports = {report.name: report for report in await gateway.list_clusters()}
                statuses = {}
                for record in records:
                    section = record.section("gateway")
                    report = reports.get(section.get("name"))
                    if section.get("address") != address:
                        statuses[record.id] = Status("unknown")
                    elif report is None:
                        statuses[record.id] = Status("gone", reason=await self._ending(gateway, section.get("name")))
                    else:
                        statuses[record.id] = Status(
                            _STATES.get(report.status.name, "stopping"), dashboard=report.dashboard_link
                        )
                return statuses
        except Exception:
            # An unreachable gateway says nothing about its clusters: keep them all.
            return {record.id: Status("unknown") for record in records}

    async def stop(self, record: Record) -> None:
        name = record.section("gateway").get("name")
        if not isinstance(name, str):
            return
        try:
            async with self._open() as gateway:
                await gateway.stop_cluster(name)
        except Exception as error:
            raise BackendError(f"Dask Gateway could not stop the cluster: {error}") from error

    async def _ending(self, gateway, name) -> str:
        try:
            report = await gateway.get_cluster(name)
        except Exception:
            return "ended"
        return _ENDINGS.get(report.status.name, "ended")
