"""List a project's available Jupyter AI personas before its first chat opens."""

import asyncio
import base64
import mimetypes
from pathlib import Path
from uuid import uuid4

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from jupyterlab_chat.ychat import YChat
from tornado import web

from .agent_defaults import read_project_agent
from .project_routes import ProjectAPIHandler


def persona_avatar(persona):
    """Inline a small installed avatar, before Jupyter AI's chat avatar cache exists."""
    path = Path(persona.defaults.avatar_path)
    mime, _ = mimetypes.guess_type(path)
    if mime not in {"image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp"}:
        return None
    try:
        with path.open("rb") as stream:
            data = stream.read(256 * 1024 + 1)
    except OSError:
        return None
    if len(data) > 256 * 1024:
        return None
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


async def available_agents(extension, root, project):
    """Discover through an in-memory manager, without preparing agents or saving a chat.

    Jupyter AI exposes persona metadata only on instances. Its constructor
    discovers installed and project-local personas; preparation (which starts
    ACP processes) is a separate lifecycle step that discovery never calls.
    No event logger is attached, so this temporary list cannot affect live chats.
    """
    chat = YChat()
    chat.initial_path = (project.relative_to(root) / f"{uuid4()}.chat").as_posix()
    manager = extension.persona_manager_class(
        parent=extension,
        chat=chat,
        root_dir=str(root),
        base_url=extension.serverapp.web_app.settings.get("base_url", "/"),
        event_loop=asyncio.get_running_loop(),
    )
    try:
        personas = sorted(
            ({"id": persona.id, "name": persona.name, "avatar_url": persona_avatar(persona)}
             for persona in manager.personas.values()),
            key=lambda persona: (persona["name"].casefold(), persona["id"]),
        )
        ids = {persona["id"] for persona in personas}
        preferred = read_project_agent(project)
        if preferred not in ids:
            preferred = manager.default_persona_id
        if preferred not in ids:
            preferred = personas[0]["id"] if len(personas) == 1 else None
        return {"personas": personas, "default": preferred}
    finally:
        # No persona was prepared: do not shut down class-shared ACP clients
        # that may belong to other, live chats. Only release this document.
        chat.unobserve()


class ProjectAgentsHandler(ProjectAPIHandler):
    """Project-scoped agent choices for Home's new-session composer."""

    @web.authenticated
    @authorized(action="read", resource="contents")
    async def get(self):
        """Return available personas and a valid suggested default, or null."""
        project = await self.project()
        extensions = self.serverapp.extension_manager.extension_apps.get("jupyter_ai_persona_manager", ())
        extension = next(iter(extensions), None)
        if extension is None:
            self.finish({"personas": [], "default": None})
            return
        self.finish(await available_agents(extension, self.contents_root, project))


def setup_project_agents_handlers(web_app):
    """Register the project agent directory under the server's base URL."""
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "project-agents")
    web_app.add_handlers(".*$", [(route, ProjectAgentsHandler)])
