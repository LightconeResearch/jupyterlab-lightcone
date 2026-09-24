"""Root Jupyter AI agents in the ASTRA project their chat belongs to.

Jupyter AI starts each agent session in the chat file's own folder and exposes
its manager class as the `PersonaManagerExtension.persona_manager_class`
trait. The extension ships that trait in
`etc/jupyter/jupyter_jupyter_ai_persona_manager_config.json`, the config file
Jupyter Server reads for that extension, so this subclass is the manager of
every chat unless a deployment configures another class.

The same manager is where a message meets its agent, so it also delivers the
project's pending comments with the message and remembers the agent each
project uses (`agent_defaults`): a message that names no installed agent goes
to the one the chat, or else its project, last used, instead of being dropped.
"""

from dataclasses import replace
from pathlib import Path

from jupyter_ai_persona_manager import PersonaManager as JupyterAIPersonaManager

from .agent_defaults import read_project_agent, remember_agent
from .comments import COMMENT_LOCKS, deliver_comments
from .projects import CURRENT_PROJECT, join_project, project_directory, project_entrypoint

COMMENTS_METADATA_KEY = "lightcone"
"""The message metadata entry under which the composer lists the comments it sends."""


def comment_ids(metadata) -> list[str]:
    """The ids of the comments a message carries, or none when it names none."""
    lightcone = (metadata or {}).get(COMMENTS_METADATA_KEY)
    ids = lightcone.get("comments") if isinstance(lightcone, dict) else None
    if not isinstance(ids, list):
        return []
    return [identifier for identifier in ids if isinstance(identifier, str)]


class PersonaManager(JupyterAIPersonaManager):
    """Start agent sessions at the project root, wherever the chat is stored.

    Keeps the upstream class name: Jupyter AI seeds the picker's default
    persona from the config section named after the manager class
    (`PersonaManagerExtension._default_persona_id`), so existing
    `c.PersonaManager` settings must keep applying.
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
        project = self._project()
        return str(project) if project else super().get_chat_dir()

    def on_chat_message(self, chat_id: str, message):
        """Route a message as upstream does, after choosing its agent and attaching its comments.

        Jupyter AI's picker forgets its choice whenever a chat's view is
        rebuilt, and upstream drops a message that names no installed persona.
        Here such a message goes to the agent this chat last addressed, else
        the one its project last used; only a chat with neither drops it. The
        copy handed to upstream names that agent, so upstream's own routing
        and processing boundary deliver it.
        """
        persona_id = (message.metadata or {}).get(self.TO_PERSONA_METADATA_KEY)
        persona = self.personas.get(persona_id) if persona_id else None
        if persona is None:
            persona = self._usual_persona()
            if persona is None:
                self.log.debug("A message named %s, not an agent of this chat, and it has no usual agent.", persona_id)
                return
            self.log.info(
                "A message named %s, not an agent of this chat; it goes to %s, the agent last used here.",
                persona_id or "no agent",
                persona.name,
            )
        self.event_loop.create_task(self._deliver(chat_id, persona, message))

    def _usual_persona(self):
        """The persona this chat's messages last named, else its project's recorded one."""
        try:
            messages = self.chat.get_messages()
        except TypeError:
            # Jupyter Chat rebuilds each stored message with Message(**dict); a
            # chat file another tool wrote may hold fields the model lacks.
            self.log.warning("Could not read this chat's messages.", exc_info=True)
            messages = []
        for earlier in reversed(messages):
            if earlier.sender in self.personas:
                continue
            named = (earlier.metadata or {}).get(self.TO_PERSONA_METADATA_KEY)
            persona = self.personas.get(named) if isinstance(named, str) else None
            if persona is not None:
                return persona
        project = self._project()
        recorded = read_project_agent(project) if project is not None else None
        return self.personas.get(recorded) if recorded else None

    async def _deliver(self, chat_id: str, persona, message) -> None:
        """Hand upstream a copy addressed to `persona`, with the pending comments appended."""
        remember_agent(self._project(), persona.id, self.log)
        ids = comment_ids(message.metadata)
        if ids:
            message = await self._with_comments(message, ids)
        addressed = replace(message, metadata={**(message.metadata or {}), self.TO_PERSONA_METADATA_KEY: persona.id})
        super().on_chat_message(chat_id, addressed)

    async def _with_comments(self, message, ids: list[str]):
        """A copy of the message whose body ends with the pending comments' block.

        The chat file keeps the user's own text: only the copy handed to the
        persona carries the block. The comments are marked sent with this
        message; missing or already sent ids are skipped. A store that cannot
        be read leaves the message as it was, so the agent still answers.
        """
        project = self._project()
        if project is None:
            self.log.warning("Comments were not delivered: this chat belongs to no ASTRA project.")
            return message
        try:
            block = await deliver_comments(
                self._settings.setdefault(COMMENT_LOCKS, {}),
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

    def _project(self) -> Path | None:
        """This chat's ASTRA project, joining the current one when it has none.

        The one lookup behind the working directory, the usual agent and the
        comments. Upstream's `get_chat_dir` cannot fail and is called while a
        manager is built, so an unreadable parent folder is logged and the
        chat is treated as belonging to no project rather than losing its
        personas.
        """
        try:
            return join_project(self, self._settings.get(CURRENT_PROJECT))
        except OSError:
            self.log.warning("Could not locate the ASTRA project for this chat.", exc_info=True)
            return None

    @property
    def _settings(self) -> dict:
        """The running server's web application settings, through the extension app that made this manager."""
        return self.parent.serverapp.web_app.settings


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
