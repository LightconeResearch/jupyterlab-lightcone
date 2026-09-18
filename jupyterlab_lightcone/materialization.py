"""Read-only materialization status from the Lightcone engine."""

import asyncio
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from lightcone.engine.materialize import status
from lightcone.engine.project import ProjectError, current_project
from tornado import web

from .project_routes import ProjectAPIHandler


def read_status(project: Path) -> dict:
    """Ask the engine what state each output is in; it runs and commits nothing.

    The UI shows the engine's own states (current, behind, stale) and reasons,
    so a marker and a line of `lc status` name the same thing.
    """
    try:
        report = status(current_project(project))
    except ProjectError as error:
        raise web.HTTPError(503, "Lightcone could not read this project's status:\n%s", str(error)) from error
    return {
        "outputs": {
            output.output: {"state": output.status, "detail": output.why}
            for output in report.outputs
        }
    }


class MaterializationStatusHandler(ProjectAPIHandler):
    """An authenticated status lookup; an unreadable project is an optional-service error."""

    unavailable_message = "Materialization status requires local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Report all universes together so the client can select the active one."""
        project = await self.project()
        # Status hashes the declared inputs, so it runs off the event loop.
        self.finish(await asyncio.to_thread(read_status, project))


def setup_materialization_handlers(web_app):
    """Register status under the server's base URL, including JupyterHub prefixes."""
    route = url_path_join(
        web_app.settings.get("base_url", "/"),
        "jupyterlab_lightcone",
        "api",
        "materialization",
    )
    web_app.add_handlers(".*$", [(route, MaterializationStatusHandler)])
