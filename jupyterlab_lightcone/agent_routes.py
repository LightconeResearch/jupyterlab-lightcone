"""The coding-agent readiness endpoint the tour reads."""

import asyncio

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .agents import agent_readiness


class AgentReadinessHandler(APIHandler):
    """Report which ACP agent adapters this server can run; nothing is installed."""

    auth_resource = "lightcone"

    @web.authenticated
    @authorized(action="read", resource="lightcone")
    async def get(self):
        """Look up the adapters now: PATH and entry points change while the server runs."""
        self.set_header("Cache-Control", "no-store")
        self.finish(await asyncio.to_thread(agent_readiness))


def setup_agent_handlers(web_app):
    """Register under the server base URL, including JupyterHub prefixes."""
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    web_app.add_handlers(".*$", [(url_path_join(api, "agents"), AgentReadinessHandler)])
