"""The agent each project last worked with, so every chat opens with it.

Jupyter AI's agent picker keeps its choice per chat view, in memory. Moving a
chat between the main area and the side panel, reopening it or reloading the
page starts the picker again from the server's default persona, and a message
addressed to no installed persona is dropped without a word.

The workbench records the persona each project's messages last went to, in
`<project>/.lightcone/agent.json`, and uses it two ways:

- `GET /jupyterlab_lightcone/api/project-agent?path=<astra.yaml>` tells the
  browser which agent to preselect in a chat of that project;
- `agent_workspace.PersonaManager` sends a message that names no installed
  agent to the chat's own last agent, or else to this one.
"""

from pathlib import Path

from jupyter_server.auth import authorized
from tornado import web

from .project_routes import ProjectAPIHandler
from .project_store import StoreError, read_json, store_path, write_json

AGENT_STORE = "agent.json"
"""The store, under the project's `.lightcone` folder, naming the persona its messages last went to."""

MAX_AGENT_BYTES = 64 * 1024


def read_project_agent(project: Path) -> str | None:
    """The persona id a project last used, or None when none is recorded or readable."""
    try:
        data = read_json(store_path(project, AGENT_STORE), MAX_AGENT_BYTES)
    except StoreError:
        return None
    persona = data.get("persona") if isinstance(data, dict) else None
    return persona if isinstance(persona, str) and persona else None


def write_project_agent(project: Path, persona_id: str) -> None:
    """Record a project's agent, atomically; an unchanged record is not rewritten."""
    if read_project_agent(project) == persona_id:
        return
    write_json(store_path(project, AGENT_STORE), {"persona": persona_id})


def remember_agent(project: Path | None, persona_id: str, log) -> None:
    """Record the agent a message just went to, for its project.

    Recording is best-effort: a read-only project still gets its answer, and
    a chat outside every project records nothing.
    """
    if project is None:
        return
    try:
        write_project_agent(project, persona_id)
    except (OSError, StoreError):
        log.warning("Could not record the agent of %s.", project, exc_info=True)


class ProjectAgentHandler(ProjectAPIHandler):
    """The agent a project last used, for the chat input to preselect."""

    @web.authenticated
    @authorized(action="read", resource="contents")
    async def get(self):
        """`{"persona": <id or null>}` for the project owning the `path` entrypoint."""
        project = await self.project()
        self.finish({"persona": read_project_agent(project)})
