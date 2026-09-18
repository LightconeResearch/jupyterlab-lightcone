"""Read-only materialization status from the installed Lightcone CLI."""

import json
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler
from .projects import run_cli

STATUS_TIMEOUT_SECONDS = 30

_ROW_FIELDS = ("output", "status", "why")
_ROW_STATUSES = frozenset({"current", "behind", "stale"})


def output_status(row: object) -> tuple[str, dict]:
    """Pass one CLI row through unchanged, rejecting anything not recognised.

    The UI shows the states `lc status` reports (current, behind, stale) and
    the CLI's own reason, so a marker and a terminal line name the same thing.
    """
    if not isinstance(row, dict) or any(
        not isinstance(row.get(key), str) for key in _ROW_FIELDS
    ):
        raise ValueError("Invalid output status")
    if row["status"] not in _ROW_STATUSES:
        raise ValueError("Unknown output status")
    return row["output"], {"state": row["status"], "detail": row["why"]}


async def read_status(project: Path) -> dict:
    """Run the fixed status command; never execute recipes or infer freshness."""
    report = await run_cli(
        "status",
        "--json",
        cwd=project,
        operation="read this project's status",
        timeout_message="Lightcone status check timed out",
        timeout=STATUS_TIMEOUT_SECONDS,
        failure_status=503,
    )
    try:
        payload = json.loads(report)
        rows = payload["outputs"]
        if not isinstance(rows, list):
            raise ValueError("Expected output statuses")
        outputs = {}
        for row in rows:
            name, status = output_status(row)
            if name in outputs:
                raise ValueError("Ambiguous output status")
            outputs[name] = status
    except (ValueError, KeyError, TypeError) as error:
        raise web.HTTPError(502, "Lightcone returned an unsupported status report") from error
    return {"outputs": outputs}


class MaterializationStatusHandler(ProjectAPIHandler):
    """An authenticated status lookup; an unavailable CLI is an optional-service error."""

    unavailable_message = "Materialization status requires local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Report all universes together so the client can select the active one."""
        project = await self.project()
        self.finish(await read_status(project))


def setup_materialization_handlers(web_app):
    """Register status under the server's base URL, including JupyterHub prefixes."""
    route = url_path_join(
        web_app.settings.get("base_url", "/"),
        "jupyterlab_lightcone",
        "api",
        "materialization",
    )
    web_app.add_handlers(".*$", [(route, MaterializationStatusHandler)])
