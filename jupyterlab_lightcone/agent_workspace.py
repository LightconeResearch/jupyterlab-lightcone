"""Root Jupyter AI agents in the ASTRA project that owns their chat.

Jupyter AI starts each agent session in the chat file's own folder. It exposes
its manager class as the `PersonaManagerExtension.persona_manager_class` trait;
`select_project_persona_manager` sets that trait when Jupyter AI is installed.
"""

from jupyter_ai_persona_manager import PersonaManager as JupyterAIPersonaManager

from .projects import chat_project


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
        """Return the owning ASTRA project, or the chat's folder outside one.

        ACP personas pass this directory as the session's working directory,
        so `lc`, `astra` and relative paths resolve against the project.
        """
        try:
            project = chat_project(self)
        except OSError:
            # Upstream's version cannot fail, and it is called while a persona
            # manager is built: an unreadable parent must not leave a chat with
            # no personas at all.
            self.log.warning("Could not locate the ASTRA project for this chat.", exc_info=True)
            project = None
        return str(project) if project else super().get_chat_dir()


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
