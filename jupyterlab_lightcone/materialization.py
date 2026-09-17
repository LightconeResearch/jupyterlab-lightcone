"""Read-only materialization status from the installed Lightcone CLI."""

import asyncio
import json
from pathlib import Path
import shutil
import subprocess

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web


def project_root(root: Path, path: str) -> Path:
    """Resolve only a local ASTRA entrypoint within the contents root."""
    if not path or path.startswith("/") or "\\" in path or ":" in path:
        raise web.HTTPError(400, reason="A local astra.yaml path is required")
    if ".." in path.split("/") or Path(path).name != "astra.yaml":
        raise web.HTTPError(400, reason="A local astra.yaml path is required")
    entrypoint = (root / path).resolve()
    if not entrypoint.is_relative_to(root.resolve()):
        raise web.HTTPError(403, reason="Project is outside the contents root")
    return entrypoint.parent


class ProjectAPIHandler(APIHandler):
    """Read-only access to one local ASTRA project, on the contents manager's terms.

    Every Lightcone read endpoint shares this preamble, so the local-manager
    requirement, the entrypoint resolution and the contents manager's own read
    and hidden-file rules are stated once.
    """

    auth_resource = "contents"
    unavailable_reason = "This endpoint requires local files"

    @property
    def contents_root(self) -> Path:
        return Path(self.contents_manager.root_dir).resolve()

    async def project(self) -> Path:
        """Resolve and authorize the requested project directory."""
        if not isinstance(self.contents_manager, FileContentsManager):
            raise web.HTTPError(503, reason=self.unavailable_reason)
        path = self.get_query_argument("path")
        project = project_root(self.contents_root, path)
        # Apply the contents manager's read and hidden-file rules too.
        await ensure_async(self.contents_manager.get(path, content=False, type="file"))
        self.set_header("Cache-Control", "no-store")
        return project


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


def read_status(project: Path) -> dict:
    """Run the fixed status command; never execute recipes or infer freshness."""
    executable = shutil.which("lc")
    if not executable:
        raise web.HTTPError(503, reason="Lightcone CLI is not installed on this server")
    try:
        process = subprocess.run(
            [executable, "status", "--json"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=STATUS_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise web.HTTPError(504, reason="Lightcone status check timed out") from error
    except OSError as error:
        raise web.HTTPError(503, reason="Lightcone CLI could not be started") from error
    if process.returncode:
        raise web.HTTPError(503, reason="Lightcone could not read this project's status")
    try:
        payload = json.loads(process.stdout)
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
        raise web.HTTPError(502, reason="Lightcone returned an unsupported status report") from error
    return {"outputs": outputs}


class MaterializationStatusHandler(ProjectAPIHandler):
    """An authenticated status lookup; an unavailable CLI is an optional-service error."""

    unavailable_reason = "Materialization status requires local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Report all universes together so the client can select the active one."""
        project = await self.project()
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
