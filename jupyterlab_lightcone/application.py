"""Jupyter lifecycle integration for Lightcone's server routes."""

from jupyter_server.extension.application import ExtensionApp

from .materialization import setup_materialization_handlers
from .provenance import setup_provenance_handlers
from .routes import setup_route_handlers
from .project_routes import setup_project_handlers
from .projects import expose_engine_tools


class LightconeApp(ExtensionApp):
    """Register Lightcone's project, paper and agent integration with Jupyter Server."""

    name = "jupyterlab_lightcone"

    def initialize_settings(self):
        """Prepare the environment the in-process Lightcone engine relies on."""
        expose_engine_tools()
        self._root_agents_in_projects()

    def _root_agents_in_projects(self):
        """Start Jupyter AI agents at their project root; a no-op without Jupyter AI.

        Optional and best-effort: no Jupyter AI incompatibility may stop the
        inventory and paper routes from loading.
        """
        try:
            from .agent_workspace import select_project_persona_manager

            selected = select_project_persona_manager(self.serverapp)
        except ImportError:
            return
        except Exception:
            self.log.warning(
                "Could not root Jupyter AI agents in their ASTRA project.", exc_info=True
            )
            return
        self.log.info(
            "Jupyter AI agents start in the ASTRA project that owns their chat."
            if selected
            else "Jupyter AI uses a configured persona manager; agent folders are unchanged."
        )

    def initialize_handlers(self):
        """Register the paper, project, materialization and provenance routes."""
        app = self.serverapp.web_app
        setup_route_handlers(app)
        setup_project_handlers(app)
        setup_materialization_handlers(app)
        setup_provenance_handlers(app)
