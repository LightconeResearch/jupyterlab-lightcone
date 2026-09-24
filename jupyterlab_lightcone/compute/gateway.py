"""Clusters on Dask Gateway, as a JupyterHub deployment on Kubernetes offers it.

The gateway keeps the cluster, its TLS credentials and its lifetime (its own
idle timeout); the record only names it. Workers run this server's image, so
they run the same engine as this server. Clusters are adaptive between one
worker and the preset's maximum: the one worker is what the engine checks its
version against when it attaches.
"""

from __future__ import annotations

import importlib.util
import os

from .backend import BackendError, Status, integer, number
from .records import Record, write_record

MARKER = "LIGHTCONE_CLUSTER"
"""The environment variable, set in every scheduler and worker pod, naming the record."""

_STATES = {"PENDING": "starting", "RUNNING": "running", "STOPPING": "stopping"}
_ENDINGS = {"STOPPED": "was stopped", "FAILED": "failed"}

OPTION_FIELDS = (("cores", "worker_cores"), ("memory", "worker_memory"))
"""Preset fields and the cluster options of a standard daskhub deployment they set."""


def server_image() -> str | None:
    """The image this Jupyter server runs, as KubeSpawner announces it."""
    return os.environ.get("JUPYTER_IMAGE_SPEC") or os.environ.get("JUPYTER_IMAGE") or None


def server_gateway() -> str | None:
    """The configured gateway address, expanded as the Gateway client expands it."""
    import dask.config

    address = dask.config.get("gateway.address", None)
    if not isinstance(address, str) or not address:
        return None
    try:
        return address.format(**os.environ).rstrip("/") or None
    except (KeyError, ValueError):
        return None


def _default_gateway():
    from dask_gateway import Gateway

    return Gateway(asynchronous=True)


class GatewayBackend:
    """Clusters the user's Dask Gateway starts and culls, authenticated by JupyterHub."""

    name = "gateway"

    def __init__(self, factory=_default_gateway):
        self._factory = factory

    def available(self) -> bool:
        return importlib.util.find_spec("dask_gateway") is not None and server_gateway() is not None

    def validate(self, preset: dict) -> dict:
        return {
            "workers": integer(preset, "workers", 2, 1, 1000),
            "cores": number(preset, "cores", 0.1, 1024),
            "memory": number(preset, "memory", 0.1, 4096),
        }

    async def start(self, record: Record, spec: dict) -> None:
        image = server_image()
        persisted = False
        try:
            async with self._factory() as gateway:
                options = await gateway.cluster_options()
                if "image" not in options:
                    raise BackendError("This gateway must expose an image option so Lightcone can identify its workers' environment.")
                try:
                    if image:
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
                if not isinstance(options["image"], str) or not options["image"]:
                    raise BackendError("This gateway must report a nonempty worker image before a cluster can start.")
                name = await gateway.submit(options)
                record.data["gateway"] = {
                    "name": name,
                    "address": gateway.address,
                    **{key: value for key, value in spec.items() if value is not None},
                }
                record.data["workers"]["image"] = options["image"]
                # Submission already owns resources. Persist its handle before
                # the next request, so an adaptation failure cannot orphan it.
                write_record(record)
                persisted = True
                await gateway.adapt_cluster(name, minimum=1, maximum=spec["workers"])
        except BaseException as error:
            cleanup_error = None
            if record.section("gateway").get("name"):
                try:
                    await self.stop(record)
                except BackendError as failure:
                    cleanup_error = failure
            if not isinstance(error, Exception):
                raise
            if cleanup_error is not None:
                recovery = "The cluster remains recorded; use Stop to retry." if persisted else (
                    f"Cluster {record.section('gateway')['name']} could not be recorded; "
                    f"stop it directly through Dask Gateway at {record.section('gateway')['address']}."
                )
                raise BackendError(
                    f"Dask Gateway could not finish starting the cluster: {error}. "
                    f"Cleanup also failed: {cleanup_error}. {recovery}"
                ) from error
            if isinstance(error, BackendError):
                raise
            raise BackendError(f"Dask Gateway could not start the cluster: {error}") from error

    async def statuses(self, records: list[Record]) -> dict[str, Status]:
        if not records:
            return {}
        try:
            async with self._factory() as gateway:
                address = gateway.address
                reports = {
                    report.name: report
                    for report in await gateway.list_clusters(status=["pending", "running", "stopping"])
                }
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
            async with self._factory() as gateway:
                if record.section("gateway").get("address") != gateway.address:
                    raise BackendError("This cluster belongs to another Dask Gateway; stop it from a server using that gateway.")
                await gateway.stop_cluster(name)
        except BackendError:
            raise
        except Exception as error:
            raise BackendError(f"Dask Gateway could not stop the cluster: {error}") from error

    async def _ending(self, gateway, name) -> str:
        try:
            report = await gateway.get_cluster(name)
        except Exception:
            return "ended"
        return _ENDINGS.get(report.status.name, "ended")
