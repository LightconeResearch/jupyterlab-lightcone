"""Jupyter lifecycle integration for Lightcone's server routes."""

import asyncio
import os

from jupyter_server.extension.application import ExtensionApp

from .agent_activity import watch_persona_activity
from .agent_tools import add_server_instructions
from .comments import COMMENT_DELIVERY, setup_comment_handlers
from .project_agents import setup_project_agents_handlers
from .materialization import setup_materialization_handlers
from .provenance import setup_provenance_handlers
from .versions import setup_versions_handlers
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
        self._root_agents_in_projects()
        self._configure_agents()
        self._publish_server_root()

    def _publish_server_root(self):
        """Publish the absolute contents root for paths linked in agent replies.

        JupyterLab abbreviates roots inside the home directory as ``~/...``;
        absolute filesystem paths cannot be resolved against that spelling.
        """
        root = getattr(self.serverapp.contents_manager, "root_dir", None)
        if isinstance(root, str) and root:
            config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
            config["lightconeServerRoot"] = os.path.abspath(root)


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

    def _configure_agents(self):
        """Say how comments reach the agents, and follow the agents' activity.

        Lightcone's manager is selected first, while the extension loads. It
        appends pending comments to the prompt it hands the persona; where a
        deployment configured another manager, the composer appends them to
        the message text instead. Activity comes from persona events.
        """
        page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
        prompt = False
        try:
            from .agent_workspace import delivers_comments

            prompt = delivers_comments(self.serverapp)
        except ImportError:
            pass
        except Exception:
            self.log.warning("Could not configure pending comment delivery.", exc_info=True)
        page_config[COMMENT_DELIVERY] = "prompt" if prompt else "message"
        watch_persona_activity(self.serverapp)

    async def _start_jupyter_server_extension(self, serverapp):
        """Tell agents when to use Lightcone's MCP tools, once Jupyter's MCP server exists.

        Jupyter Server starts its extensions concurrently. The MCP extension
        creates its server before it first waits, so yielding once lets it
        get there even when this start runs first. Best-effort, like the
        other agent integrations.
        """
        await asyncio.sleep(0)
        try:
            added = add_server_instructions(serverapp)
        except Exception:
            self.log.warning("Could not give agents instructions for Lightcone's MCP tools.", exc_info=True)
            return
        self.log.info(
            "Agents are told when to use Lightcone's MCP tools."
            if added
            else "Jupyter's MCP server is not running; agents get no instructions for Lightcone's tools."
        )

    def initialize_handlers(self):
        """Register the paper, project, materialization, provenance and session routes."""
        app = self.serverapp.web_app
        setup_route_handlers(app)
        setup_project_handlers(app)
        setup_materialization_handlers(app)
        setup_provenance_handlers(app)
        setup_session_handlers(app)
        setup_project_agents_handlers(app)
        setup_versions_handlers(app)
        setup_comment_handlers(app)
