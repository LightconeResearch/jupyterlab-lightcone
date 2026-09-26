"""The Lightcone server extension: routes, page configuration, agent integration and the MySTRA viewer."""

import os

from jupyter_server.extension.application import ExtensionApp
from traitlets import Float, List, Unicode

from .agent_activity import watch_persona_activity
from .project_agents import setup_project_agents_handlers
from .agent_workspace import delivers_comments
from .comments import COMMENT_DELIVERY, setup_comment_handlers
from .materialization import setup_materialization_handlers
from .provenance import setup_provenance_handlers
from .mystra import MySTRAManager
from .mystra_routes import setup_mystra_handlers
from .routes import setup_route_handlers
from .project_routes import setup_project_handlers
from .projects import expose_engine_tools
from .sessions import setup_session_handlers
from .versions import setup_versions_handlers


class LightconeApp(ExtensionApp):
    """Register the workbench routes, publish what the frontend needs to know
    about the server, follow the Jupyter AI agents' activity, and own the
    MySTRA viewer processes through Jupyter's shutdown lifecycle."""

    name = "jupyterlab_lightcone"
    manager: MySTRAManager | None = None
    """The viewer processes, created with the handlers; None until then."""
    mystra_command = List(
        Unicode(),
        default_value=["myst"],
        config=True,
        help="MyST executable and optional fixed arguments; no shell is used.",
    )
    mystra_idle_timeout = Float(
        120,
        min=30,
        config=True,
        help="Seconds without a viewer heartbeat before stopping MyST.",
    )
    mystra_startup_timeout = Float(
        120,
        min=1,
        config=True,
        help="Maximum seconds to install/build/start a MySTRA theme.",
    )

    def initialize_settings(self):
        """Prepare the environment the in-process Lightcone engine relies on and describe the agents' setup."""
        expose_engine_tools()
        self._configure_agents()
        self._publish_server_root()

    def _publish_server_root(self):
        """Give the frontend the absolute contents root agents write paths under.

        JupyterLab's `serverRoot` shortens a root inside the home directory to
        `~/...`, which no absolute path in a chat can be matched against.
        """
        root = getattr(self.serverapp.contents_manager, "root_dir", None)
        if isinstance(root, str) and root:
            page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
            page_config["lightconeServerRoot"] = os.path.abspath(root)

    def _configure_agents(self):
        """Say how comments reach the agents, and follow the agents' activity.

        Lightcone's persona manager, configured through Jupyter AI's own
        config file, appends pending comments to the prompt it hands the
        persona; where a deployment configured another manager, the composer
        appends them to the message text instead. Activity comes from the
        persona events every manager publishes.
        """
        page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
        prompt = delivers_comments(self.serverapp)
        page_config[COMMENT_DELIVERY] = "prompt" if prompt else "message"
        watch_persona_activity(self.serverapp)
        self.log.info(
            "Jupyter AI agents start in the ASTRA project that owns their chat."
            if prompt
            else "Jupyter AI uses a configured persona manager; agent folders are unchanged."
        )

    def initialize_handlers(self):
        """Register every workbench route and add lazy MySTRA sessions."""
        app = self.serverapp.web_app
        setup_route_handlers(app)
        setup_project_handlers(app)
        setup_materialization_handlers(app)
        setup_provenance_handlers(app)
        setup_session_handlers(app)
        setup_versions_handlers(app)
        setup_comment_handlers(app)
        setup_project_agents_handlers(app)
        self.manager = MySTRAManager(
            getattr(
                self.serverapp.contents_manager, "root_dir", self.serverapp.root_dir
            ),
            app.settings.get("base_url", "/"),
            list(self.mystra_command),
            self.log,
            self.mystra_idle_timeout,
            self.mystra_startup_timeout,
        )
        setup_mystra_handlers(app, self.manager)

    async def stop_extension(self):
        """Stop the MySTRA viewer before Jupyter exits.

        Isolated: Jupyter Server awaits this hook without a guard before
        shutting kernels down, so a failure here must not skip the server's
        own cleanup.
        """
        if self.manager is not None:
            try:
                await self.manager.close()
            except Exception:
                self.log.warning("Could not stop the MySTRA viewer.", exc_info=True)
