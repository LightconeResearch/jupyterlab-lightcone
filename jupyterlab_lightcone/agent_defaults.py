"""The agent each project last worked with, so every chat opens with it.

Jupyter AI's agent picker keeps its choice per chat view, in memory. Moving a
chat between the main area and the side panel, reopening it or reloading the
page starts the picker again from the server's default persona, and a message
addressed to no installed persona is dropped without a word.

The workbench records the persona each project's messages last went to, in
`<project>/.lightcone/agent.json` (a folder the engine's `.gitignore` template
already ignores, like the comment store), and uses it three ways:

- Jupyter AI's page default (`jupyter_ai_default_persona`) follows the agent
  last used, so every picker a reload creates starts on a real agent;
- `GET /jupyterlab_lightcone/api/project-agent?path=<astra.yaml>` tells the
  browser which agent to preselect in a chat of that project;
- `agent_workspace.PersonaManager` sends a message that names no installed
  agent to the chat's own last agent, or else to this one.
"""

import json
import os
from pathlib import Path
import tempfile

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler

AGENT_FILE = Path(".lightcone", "agent.json")
"""Where a project keeps the persona its messages last went to."""

DEFAULT_PERSONA_OPTION = "jupyter_ai_default_persona"
"""The page config option Jupyter AI's picker starts from."""

HANDLERS_SETTING = "jupyterlab_lightcone.project_agent_handlers"


def read_project_agent(project: Path) -> str | None:
    """The persona id a project last used, or None when none is recorded or readable."""
    try:
        data = json.loads((project / AGENT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    persona = data.get("persona") if isinstance(data, dict) else None
    return persona if isinstance(persona, str) and persona else None


def write_project_agent(project: Path, persona_id: str) -> None:
    """Record a project's agent, atomically; an unchanged record is not rewritten."""
    if read_project_agent(project) == persona_id:
        return
    path = project / AGENT_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".agent-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"persona": persona_id}, stream)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def remember_agent(web_app, project: Path | None, persona_id: str, log) -> None:
    """Record the agent a message just went to, for its project and for the next page load.

    Recording is best-effort: a read-only project still gets its answer.
    """
    if web_app is not None:
        web_app.settings.setdefault("page_config_data", {})[DEFAULT_PERSONA_OPTION] = persona_id
    if project is None:
        return
    try:
        write_project_agent(project, persona_id)
    except OSError:
        log.warning("Could not record the agent of %s.", project, exc_info=True)


class ProjectAgentHandler(ProjectAPIHandler):
    """The agent a project last used, for the chat input to preselect."""

    @web.authenticated
    @authorized(action="read", resource="contents")
    async def get(self):
        """`{"persona": <id or null>}` for the project owning the `path` entrypoint."""
        project = await self.project()
        self.finish({"persona": read_project_agent(project)})


def setup_project_agent_handlers(web_app) -> None:
    """Register under the server base URL, including JupyterHub prefixes; idempotent."""
    if web_app.settings.get(HANDLERS_SETTING):
        return
    web_app.settings[HANDLERS_SETTING] = True
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    web_app.add_handlers(".*$", [(url_path_join(api, "project-agent"), ProjectAgentHandler)])
