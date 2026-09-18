"""Jupyter lifecycle integration for Lightcone's managed resources."""

from jupyter_server.extension.application import ExtensionApp
from traitlets import Float, List, Unicode

from .materialization import setup_materialization_handlers
from .provenance import setup_provenance_handlers
from .mystra import MySTRAManager
from .mystra_routes import setup_mystra_handlers
from .routes import setup_route_handlers
from .project_routes import setup_project_handlers


class LightconeApp(ExtensionApp):
    """Own viewer processes through Jupyter's normal shutdown lifecycle."""

    name = "jupyterlab_lightcone"
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

    def initialize_handlers(self):
        """Preserve existing paper routes and add lazy MySTRA sessions."""
        app = self.serverapp.web_app
        setup_route_handlers(app)
        setup_project_handlers(app)
        setup_materialization_handlers(app)
        setup_provenance_handlers(app)
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
        """Stop all CLI processes before Jupyter exits."""
        if hasattr(self, "manager"):
            await self.manager.close()
