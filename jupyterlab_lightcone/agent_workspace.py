"""Root Jupyter AI agents in the ASTRA project that owns their chat.

Jupyter AI starts each agent session in the chat file's own folder. It exposes
its manager class as the `PersonaManagerExtension.persona_manager_class` trait;
`select_project_persona_manager` sets that trait when Jupyter AI is installed.
"""

from pathlib import Path

from jupyter_ai_persona_manager import PersonaManager as JupyterAIPersonaManager

from .projects import owning_project


class PersonaManager(JupyterAIPersonaManager):
    """Start agent sessions at the project root, wherever the chat is stored.

    Keeps the upstream class name: Jupyter AI reads `default_persona_id` from
    the config section named after this class, so existing `c.PersonaManager`
    settings must keep applying.
    """

    def get_chat_dir(self) -> str:
        """Return the owning ASTRA project, or the chat's folder outside one.

        ACP personas pass this directory as the session's working directory,
        so `lc`, `astra` and relative paths resolve against the project.
        """
        chat_dir = super().get_chat_dir()
        project = owning_project(Path(self.root_dir), Path(chat_dir))
        return str(project) if project else chat_dir


def select_project_persona_manager(serverapp) -> bool:
    """Use the project-aware manager unless the deployment configured its own.

    `jupyter_server_config.d` only enables extensions, so the trait cannot be
    shipped as static config. Managers are created per chat, after every server
    extension has loaded, so setting it while loading is early enough.
    """
    apps = serverapp.extension_manager.extension_apps.get("jupyter_ai_persona_manager", ())
    selected = False
    for app in apps:
        if app.persona_manager_class is JupyterAIPersonaManager:
            app.persona_manager_class = PersonaManager
            selected = True
    return selected
