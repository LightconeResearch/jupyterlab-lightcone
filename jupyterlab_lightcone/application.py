"""Jupyter lifecycle integration for Lightcone's server routes."""

from jupyter_server.extension.application import ExtensionApp

from .materialization import setup_materialization_handlers
from .provenance import setup_provenance_handlers
from .routes import setup_route_handlers
from .project_routes import setup_project_handlers
from .projects import expose_engine_tools
from .sessions import setup_session_handlers


class LightconeApp(ExtensionApp):
    """Register Lightcone's project, paper and agent integration with Jupyter Server."""

    name = "jupyterlab_lightcone"

    def initialize_settings(self):
        """Prepare the environment the in-process Lightcone engine relies on."""
        expose_engine_tools()

    def initialize_handlers(self):
        """Register the paper, project, materialization, provenance and session routes."""
        app = self.serverapp.web_app
        setup_route_handlers(app)
        setup_project_handlers(app)
        setup_materialization_handlers(app)
        setup_provenance_handlers(app)
        setup_session_handlers(app)
