"""The shared project handler base, project selection, the current project and explicit initialization."""

import asyncio
import inspect
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web

from .projects import (
    CURRENT_PROJECT,
    describe_project,
    initialize_project,
    project_entrypoint,
    project_path,
    project_root,
    spec_project,
)


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

    def initialize(self, initializing):
        self.initializing = initializing

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
        """Initialize the explicitly selected folder with the Lightcone engine."""
        for action, resource in (("read", "contents"), ("execute", "lightcone")):
            if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, action, resource)):
                raise web.HTTPError(403, "Project initialization is not authorized.")
        body = self.get_json_body()
        if not isinstance(body, dict) or not isinstance(body.get("path"), str):
            raise web.HTTPError(400, "A project folder path is required.")
        project, _ = await self.resolve(body["path"])
        # Setup runs in a thread that cannot be stopped, so a slow one must hold
        # up only a second attempt on its own folder, never other folders.
        if project in self.initializing:
            raise web.HTTPError(409, "Setup is already running in this folder. Wait for it to finish, then retry.")
        self.initializing.add(project)
        try:
            # The create endpoint also permits retrying a partially initialized project.
            self.finish(await initialize_project(self.contents_root, project))
        finally:
            self.initializing.discard(project)


class CurrentProjectHandler(ProjectAPIHandler):
    """The workbench's current project, which chats stored outside a project join.

    The browser reports it whenever it changes; Jupyter AI starts an agent
    session as soon as a chat opens, so the server must already know it then.
    The last report wins, so with several windows the one used last decides.
    """

    unavailable_message = "Agent projects require a local filesystem ContentsManager."

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def put(self):
        """Replace the current project; null means the browser is outside every project."""
        body = self.get_json_body()
        if not isinstance(body, dict) or "entrypoint" not in body:
            raise web.HTTPError(400, "An entrypoint, or null, is required.")
        entrypoint = body["entrypoint"]
        if entrypoint is not None:
            root = self.contents_root
            project = await asyncio.to_thread(spec_project, root, entrypoint)
            if project is None:
                raise web.HTTPError(400, "The current project must be a local astra.yaml file.")
            # Apply the contents manager's read and hidden-file rules too.
            await contents_call(self.contents_manager.get, entrypoint, content=False, type="file")
            entrypoint = project_entrypoint(root, project)
        self.settings[CURRENT_PROJECT] = entrypoint
        self.finish({"entrypoint": entrypoint})


def setup_project_handlers(web_app):
    """Register under the server base URL, including JupyterHub prefixes."""
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    web_app.add_handlers(".*$", [
        (url_path_join(api, "projects"), ProjectsHandler, {"initializing": set()}),
        (url_path_join(api, "current-project"), CurrentProjectHandler),
    ])
