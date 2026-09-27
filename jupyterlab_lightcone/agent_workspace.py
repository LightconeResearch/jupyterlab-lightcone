"""Root Jupyter AI agents in the ASTRA project their chat belongs to.

Jupyter AI starts each agent session in the chat file's own folder. It exposes
its manager class as the `PersonaManagerExtension.persona_manager_class` trait;
`select_project_persona_manager` sets that trait when Jupyter AI is installed.
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
            return join_project(self, self._reported_project())
        except OSError:
            self.log.warning("Could not locate the ASTRA project for this chat.", exc_info=True)
            return None

    def _reported_project(self) -> str | None:
        """The workbench's current project entrypoint, as the browser last reported it.

        None for a manager built outside a running server, which then uses
        only the chat itself.
        """
        web_app = getattr(getattr(self.parent, "serverapp", None), "web_app", None)
        return web_app.settings.get(CURRENT_PROJECT) if web_app is not None else None


def select_project_persona_manager(serverapp) -> bool:
    """Use the project-aware manager unless the deployment chose another one.

    `jupyter_server_config.d` only enables extensions, and a static
    `jupyter_jupyter_ai_persona_manager_config.json` would take Jupyter AI's
    own config file from deployments and survive disabling this extension.
    Managers are created per chat, after every server extension has loaded,
    so setting the trait while loading is early enough.

    A deployment opts out by configuring any other class, including an explicit
    subclass of the stock one. Returns whether this manager is in use.
    """
    apps = serverapp.extension_manager.extension_apps.get("jupyter_ai_persona_manager", ())
    for app in apps:
        if app.persona_manager_class is JupyterAIPersonaManager:
            app.persona_manager_class = PersonaManager
    return any(app.persona_manager_class is PersonaManager for app in apps)
