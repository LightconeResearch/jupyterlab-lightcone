"""The shared project handler base, project selection and explicit initialization."""

import asyncio
import inspect
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web

from .projects import describe_project, initialize_project, project_path, project_root


async def contents_call(method, *args, **kwargs):
    """Support sync and async local managers without blocking server traffic."""
    if inspect.iscoroutinefunction(method):
        return await method(*args, **kwargs)
    return await ensure_async(await asyncio.to_thread(method, *args, **kwargs))


def _inspect_folder(root, value):
    project = project_path(root, value)
    return project, describe_project(root, project)


class ProjectAPIHandler(APIHandler):
    """Access to local Lightcone projects, on the contents manager's terms.

    Every Lightcone project endpoint shares this preamble, so the local-manager
    requirement, the entrypoint resolution and the contents manager's own read
    and hidden-file rules are stated once.
    """

    auth_resource = "contents"
    unavailable_message = "This endpoint requires local files"

    @property
    def contents_root(self) -> Path:
        """The local contents root; other managers cannot host a Lightcone project."""
        if not isinstance(self.contents_manager, FileContentsManager):
            raise web.HTTPError(503, self.unavailable_message)
        return Path(self.contents_manager.root_dir).resolve()

    async def project(self) -> Path:
        """Resolve and authorize the project directory named by an entrypoint query."""
        root = self.contents_root
        path = self.get_query_argument("path")
        project = project_root(root, path)
        # Apply the contents manager's read and hidden-file rules too.
        await contents_call(self.contents_manager.get, path, content=False, type="file")
        self.set_header("Cache-Control", "no-store")
        return project


class ProjectsHandler(ProjectAPIHandler):
    """Inspect a directory or initialize it only after the user's create action."""

    unavailable_message = "Project setup requires a local filesystem ContentsManager."

    def initialize(self, lock):
        self.lock = lock

    async def resolve(self, value):
        """Resolve an entered folder, which need not exist or hold a project yet."""
        manager = self.contents_manager
        project, info = await asyncio.to_thread(_inspect_folder, self.contents_root, value)
        for path in (info["path"], info["entrypoint"]):
            if not manager.allow_hidden and await contents_call(manager.is_hidden, path):
                raise web.HTTPError(403, "Hidden project paths are not available on this server.")
        return project, info

    @web.authenticated
    @authorized(action="read", resource="contents")
    async def get(self):
        """Inspect without creating directories, specs, or chat files."""
        _, info = await self.resolve(self.get_argument("path", "."))
        if self.get_argument("children", "false") == "true":
            listing = await contents_call(self.contents_manager.get, info["path"], content=True, type="directory")
            projects = []
            for child in listing["content"]:
                if child["type"] != "directory":
                    continue
                try:
                    _, candidate = await self.resolve(child["path"])
                    if candidate["hasSpec"]:
                        projects.append(child["path"])
                except web.HTTPError:
                    # An inaccessible or escaping child must not break browsing.
                    continue
            self.finish({"projects": projects})
        else:
            self.finish(info)

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """Initialize the explicitly selected folder using a fixed CLI command."""
        for action, resource in (("read", "contents"), ("execute", "lightcone")):
            if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, action, resource)):
                raise web.HTTPError(403, "Project initialization is not authorized.")
        body = self.get_json_body()
        if not isinstance(body, dict) or not isinstance(body.get("path"), str):
            raise web.HTTPError(400, "A project folder path is required.")
        async with self.lock:
            project, _ = await self.resolve(body["path"])
            # The create endpoint also permits retrying a partially initialized project.
            self.finish(await initialize_project(self.contents_root, project))


def setup_project_handlers(web_app):
    """Register under the server base URL, including JupyterHub prefixes."""
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "projects")
    web_app.add_handlers(".*$", [(route, ProjectsHandler, {"lock": asyncio.Lock()})])
