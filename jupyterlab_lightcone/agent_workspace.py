"""Root Jupyter AI agents in the ASTRA project their chat belongs to.

Jupyter AI starts each agent session in the chat file's own folder and exposes
its manager class as the `PersonaManagerExtension.persona_manager_class`
trait. The extension ships that trait in
`etc/jupyter/jupyter_jupyter_ai_persona_manager_config.json`, the config file
Jupyter Server reads for that extension, so this subclass is the manager of
every chat unless a deployment configures another class.
"""

from pathlib import Path

from jupyter_ai_persona_manager import PersonaManager as JupyterAIPersonaManager

from .projects import CURRENT_PROJECT, join_project


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

    def _project(self) -> Path | None:
        """This chat's ASTRA project, joining the current one when it has none.

        Upstream's `get_chat_dir` cannot fail and is called while a
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
