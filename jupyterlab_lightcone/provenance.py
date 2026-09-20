"""Read-only access to Lightcone's versioned run-record sidecars."""

import asyncio
import json
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import inside_root

MAX_RECORD_BYTES = 1_048_576
_STRING_FIELDS = ("finished_at", "git_sha", "recipe", "env_version", "lc_version")
_MAP_FIELDS = ("input_versions",)


def record_path(project: Path, universe: str, output: str) -> Path:
    """Lightcone schema 1: results/<universe>/.<output>.manifest.json.

    Match lightcone.engine.assets: an output ID has no dots, while a universe
    ID may. This endpoint never accepts an arbitrary hidden-file path.
    """
    if not output or any(c in output for c in "./\\\x00"):
        raise web.HTTPError(400, "Invalid output identity")
    if not universe or universe.startswith(".") or any(c in universe for c in "/\\\x00"):
        raise web.HTTPError(400, "Invalid output identity")
    record = Path("results", universe, f".{output}.manifest.json")
    return inside_root(project, record, "Run record is outside the project")


def read_record(path: Path, universe: str, output: str) -> dict:
    """Bound and validate the recorded schema before returning it to the UI."""
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_RECORD_BYTES + 1)
    except FileNotFoundError:
        return {"record": None}
    except OSError as error:
        raise web.HTTPError(503, "Run record could not be read") from error
    try:
        if len(data) > MAX_RECORD_BYTES:
            raise ValueError("Oversized record")
        record = json.loads(data)
        if (
            not isinstance(record, dict)
            or record.get("schema_version") != 1
            or record.get("universe_id") != universe
            or record.get("output_id") != output
            or any(not isinstance(record.get(key), str) for key in _STRING_FIELDS)
        ):
            raise ValueError("Unsupported record")
        for key in _MAP_FIELDS:
            values = record.get(key)
            if not isinstance(values, dict) or any(not isinstance(value, str) for value in values.values()):
                raise ValueError("Unsupported versions")
    except (ValueError, UnicodeError) as error:
        raise web.HTTPError(502, "Run record has an unsupported format") from error
    return {"record": record}


class OutputProvenanceHandler(ProjectAPIHandler):
    """Authorize project access before reading its specifically named sidecar."""

    unavailable_message = "Run records require local files"

    @web.authenticated
    @authorized
    async def get(self):
        project = await self.project()
        universe = self.get_query_argument("universe")
        output = self.get_query_argument("output")
        manifest = record_path(project, universe, output)
        # Sidecars are intentionally hidden; their containing directory must still
        # be visible/readable through the normal contents manager.
        if manifest.parent.exists():
            parent = manifest.parent.relative_to(self.contents_root).as_posix()
            await contents_call(self.contents_manager.get, parent, content=False, type="directory")
        self.finish(await asyncio.to_thread(read_record, manifest, universe, output))


def setup_provenance_handlers(web_app):
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "provenance")
    web_app.add_handlers(".*$", [(route, OutputProvenanceHandler)])
