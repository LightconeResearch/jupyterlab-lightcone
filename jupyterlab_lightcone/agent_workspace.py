"""Root Jupyter AI agents in the ASTRA project their chat belongs to.

Jupyter AI starts each agent session in the chat file's own folder. It exposes
its manager class as the `PersonaManagerExtension.persona_manager_class` trait;
`select_project_persona_manager` sets that trait when Jupyter AI is installed.

The same manager is where a message meets its agent, so it also delivers the
project's pending comments with the message, records which sessions are busy,
for the session list, and remembers the agent each project uses
(`agent_defaults`): a message that names no installed agent goes to the one
the chat, or else its project, last used, instead of being dropped.
"""

from dataclasses import replace
from pathlib import Path

from jupyter_ai_persona_manager import PersonaManager as JupyterAIPersonaManager
from jupyter_ai_persona_manager.persona_manager import _safe_process as process_safely
from jupyter_ai_persona_manager.persona_manager import is_persona

from .agent_defaults import read_project_agent, remember_agent
from .comments import COMMENT_LOCKS, deliver_comments, project_directory, timestamp
from .projects import CURRENT_PROJECT, chat_project, project_entrypoint
# The session listing reads this setting; one constant keeps writer and reader agreed.
from .sessions import SESSION_ACTIVITY

COMMENTS_METADATA_KEY = "lightcone"
"""The message metadata entry under which the composer lists the comments it sends."""


def session_activity(web_app) -> dict:
    """Every chat's activity, keyed by the chat's Contents path.

    Each entry is `{"state": "working" | "idle", "persona": <persona id>,
    "since": <ISO 8601 time>}`; a chat without an entry is idle.
    """
    return web_app.settings.setdefault(SESSION_ACTIVITY, {})


def comment_ids(metadata) -> list[str]:
    """The ids of the comments a message carries, or none when it names none."""
    lightcone = (metadata or {}).get(COMMENTS_METADATA_KEY)
    ids = lightcone.get("comments") if isinstance(lightcone, dict) else None
    if not isinstance(ids, list):
        return []
    return [identifier for identifier in ids if isinstance(identifier, str)]


class PersonaManager(JupyterAIPersonaManager):
    """Start agent sessions at the project root, wherever the chat is stored.

    Keeps the upstream class name: Jupyter AI reads `default_persona_id` from
    the config section named after this class, so existing `c.PersonaManager`
    settings must keep applying.
    """

    @classmethod
    def section_names(cls):
        """Name the shared config section once, despite two same-named classes.

        Traitlets lists one section per configurable class in the MRO, and the
        base class shares this one's name. Merging that section twice would
        apply a deployment's lazy container config (`c.PersonaManager.<list>
        .append(...)`) twice as well.
        """
        seen = dict.fromkeys(super().section_names())
        return list(seen)

    def get_chat_dir(self) -> str:
        """Return the chat's ASTRA project, or the chat's folder without one.

        ACP personas pass this directory as the session's working directory,
        so `lc`, `astra` and relative paths resolve against the project. Jupyter
        AI creates that session as soon as a persona is selected, before any
        message, so a chat stored outside every project takes the project the
        browser last reported as current.
        """
        try:
            project = chat_project(self, self._reported_project())
        except OSError:
            # Upstream's version cannot fail, and it is called while a persona
            # manager is built: an unreadable parent must not leave a chat with
            # no personas at all.
            self.log.warning("Could not locate the ASTRA project for this chat.", exc_info=True)
            project = None
        return str(project) if project else super().get_chat_dir()

    def on_chat_message(self, chat_id: str, message):
        """Route a message as upstream does, after attaching its pending comments.

        Upstream looks the persona up and schedules its processing; this does
        the same in one task, so the comment store is read on the event loop's
        terms and the session's activity brackets the persona's work.

        Jupyter AI's picker forgets its choice whenever a chat's view is
        rebuilt, and upstream drops a message that names no installed persona.
        Here such a message goes to the agent this chat last addressed, else
        the one its project last used; only a chat with neither drops it.
        """
        persona_id = (message.metadata or {}).get(self.TO_PERSONA_METADATA_KEY)
        persona = self.personas.get(persona_id) if persona_id else None
        if persona is None:
            persona = self._usual_persona()
            if persona is not None:
                self.log.info(
                    "A message named %s, not an agent of this chat; it goes to %s, the agent last used here.",
                    persona_id or "no agent",
                    persona.name,
                )
        self.log.debug("Routing message to persona: %s", persona.name if persona else None)
        if persona:
            self.event_loop.create_task(self._route(persona, message))

    def _usual_persona(self):
        """The persona this chat's messages last named, else its project's recorded one."""
        try:
            messages = self.chat.get_messages()
        except Exception:
            self.log.debug("Could not read this chat's messages.", exc_info=True)
            messages = []
        for earlier in reversed(messages):
            sender = getattr(earlier, "sender", "")
            if isinstance(sender, str) and is_persona(sender):
                continue
            named = (getattr(earlier, "metadata", None) or {}).get(self.TO_PERSONA_METADATA_KEY)
            persona = self.personas.get(named) if isinstance(named, str) else None
            if persona is not None:
                return persona
        project = self._project()
        recorded = read_project_agent(project) if project is not None else None
        return self.personas.get(recorded) if recorded else None

    def _project(self) -> Path | None:
        """This chat's ASTRA project, or None without one or when it cannot be read."""
        try:
            return chat_project(self, self._reported_project())
        except OSError:
            self.log.debug("Could not locate the ASTRA project for this chat.", exc_info=True)
            return None

    async def _route(self, persona, message) -> None:
        """Deliver the message, with its comments, and track the session's activity."""
        remember_agent(self._web_app(), self._project(), persona.id, self.log)
        ids = comment_ids(message.metadata)
        if ids:
            message = await self._with_comments(message, ids)
        activity = self._activity()
        path = self.get_chat_path(relative=True)
        self._lightcone_busy = getattr(self, "_lightcone_busy", 0) + 1
        activity[path] = {"state": "working", "persona": persona.id, "since": timestamp()}
        try:
            await process_safely(persona, message)
        finally:
            self._lightcone_busy -= 1
            if self._lightcone_busy == 0:
                activity[path] = {"state": "idle", "persona": persona.id, "since": timestamp()}

    async def _with_comments(self, message, ids: list[str]):
        """A copy of the message whose body ends with the pending comments' block.

        The chat file keeps the user's own text: only the copy handed to the
        persona carries the block. The comments are marked sent with this
        message; missing or already sent ids are skipped. Any failure leaves
        the message as it was, so the agent still answers.
        """
        try:
            project = chat_project(self, self._reported_project())
            if project is None:
                self.log.warning("Comments were not delivered: this chat belongs to no ASTRA project.")
                return message
            block = await deliver_comments(
                self._comment_locks(),
                project,
                project_directory(project_entrypoint(Path(self.root_dir), project)),
                ids,
                self.get_chat_path(relative=True),
                message.id,
            )
        except Exception:
            self.log.warning("Pending comments could not be delivered with this message.", exc_info=True)
            return message
        if block is None:
            return message
        return replace(message, body=f"{message.body}\n\n{block}")

    def _web_app(self):
        """The running server's web application, absent outside a server."""
        return getattr(getattr(self.parent, "serverapp", None), "web_app", None)

    def _reported_project(self) -> str | None:
        """The workbench's current project entrypoint, as the browser last reported it."""
        web_app = self._web_app()
        return web_app.settings.get(CURRENT_PROJECT) if web_app is not None else None

    def _activity(self) -> dict:
        """The server's session activity, or a throwaway map outside a server."""
        web_app = self._web_app()
        return session_activity(web_app) if web_app is not None else {}

    def _comment_locks(self) -> dict:
        """The server's per-project store locks, or fresh ones outside a server."""
        web_app = self._web_app()
        return web_app.settings.setdefault(COMMENT_LOCKS, {}) if web_app is not None else {}


def delivers_comments(serverapp) -> bool:
    """Whether every Jupyter AI persona manager is Lightcone's, which appends comments to prompts.

    A deployment that configured another class (not derived from this one)
    leaves the composer to append the comments to the message itself.
    """
    apps = serverapp.extension_manager.extension_apps.get("jupyter_ai_persona_manager", ())
    return bool(apps) and all(
        isinstance(app.persona_manager_class, type) and issubclass(app.persona_manager_class, PersonaManager)
        for app in apps
    )


def select_project_persona_manager(serverapp) -> bool:
    """Use the project-aware manager unless the deployment chose another one.

    `jupyter_server_config.d` only enables extensions, so the trait cannot be
    shipped as static config. Managers are created per chat, after every server
    extension has loaded, so setting it while loading is early enough.

    A deployment opts out by configuring any other class, including an explicit
    subclass of the stock one.
    """
    apps = serverapp.extension_manager.extension_apps.get("jupyter_ai_persona_manager", ())
    stock = [app for app in apps if app.persona_manager_class is JupyterAIPersonaManager]
    for app in stock:
        app.persona_manager_class = PersonaManager
    return bool(stock)
