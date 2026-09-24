"""The Compute section's API: list where runs can go, start a cluster, stop one."""

from __future__ import annotations

import shutil

from jupyter_server.auth import authorized
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web

from ..project_routes import ProjectAPIHandler
from .backend import BackendError, PresetError
from .gateway import GatewayBackend
from .local import LocalBackend
from .service import ComputeService, ConflictError
from .slurm import SlurmBackend

SERVICE_SETTING = "lightcone_compute"
"""The web application setting holding this server's ComputeService."""

CLUSTER_ID = r"([0-9]{8}-[0-9]{6}-[a-z0-9]{4})"


class ComputeHandler(ProjectAPIHandler):
    """Compute is the user's, not a project's; a project only decides which target is active."""

    auth_resource = "lightcone"
    unavailable_message = "Compute requires local files"

    @property
    def service(self) -> ComputeService:
        return self.settings[SERVICE_SETTING]

    async def optional_project(self, entrypoint):
        """The project an entrypoint names, after the contents checks; None without one."""
        if entrypoint is None:
            return None
        if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, "read", "contents")):
            raise web.HTTPError(403, "Reading this project is not authorized.")
        return await self.project_named(entrypoint)

    @web.authenticated
    @authorized(action="read", resource="lightcone")
    async def get(self):
        """Where runs can go, which one they will, and clusters that just ended."""
        project = await self.optional_project(self.get_query_argument("path", None))
        self.set_header("Cache-Control", "no-store")
        self.finish(await self.service.listing(project))


class ClustersHandler(ComputeHandler):
    """Start a cluster from a preset."""

    @web.authenticated
    @authorized(action="execute", resource="lightcone")
    async def post(self):
        body = self.get_json_body()
        if not isinstance(body, dict):
            raise web.HTTPError(400, "A JSON body with a preset is required.")
        project = await self.optional_project(body.get("path"))
        try:
            target = await self.service.create(body.get("preset"), project)
        except PresetError as error:
            raise web.HTTPError(400, str(error)) from error
        except ConflictError as error:
            raise web.HTTPError(409, str(error)) from error
        except BackendError as error:
            raise web.HTTPError(502, str(error)) from error
        self.set_status(201)
        self.finish(target)


class ClusterHandler(ComputeHandler):
    """Stop one cluster."""

    @web.authenticated
    @authorized(action="execute", resource="lightcone")
    async def delete(self, cluster_id):
        try:
            await self.service.stop(cluster_id)
        except KeyError as error:
            raise web.HTTPError(404, "No such cluster.") from error
        except BackendError as error:
            raise web.HTTPError(502, str(error)) from error
        self.set_status(204)
        self.finish()


def setup_compute_handlers(web_app, idle_timeout: int) -> ComputeService:
    """Register the compute routes and the service they share, under the server's base URL."""
    base_url = web_app.settings.get("base_url", "/")
    service = ComputeService(
        [GatewayBackend(), SlurmBackend(idle_timeout, shutil.which), LocalBackend(idle_timeout)],
        base_url=base_url,
        idle_timeout=idle_timeout,
    )
    web_app.settings[SERVICE_SETTING] = service
    api = url_path_join(base_url, "jupyterlab_lightcone", "api", "compute")
    web_app.add_handlers(
        ".*$",
        [
            (api, ComputeHandler),
            (url_path_join(api, "clusters"), ClustersHandler),
            (url_path_join(api, "clusters", CLUSTER_ID), ClusterHandler),
        ],
    )
    return service


async def close_compute(web_app) -> None:
    """Stop the local clusters this server launched; a no-op before setup."""
    service = web_app.settings.get(SERVICE_SETTING)
    if isinstance(service, ComputeService):
        await service.close()
