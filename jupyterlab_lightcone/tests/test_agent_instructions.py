"""Agents are told when to use Lightcone's MCP tools before they search for them."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from fastmcp import Client, FastMCP

from jupyterlab_lightcone.agent_tools import SERVER_INSTRUCTIONS, add_server_instructions
from jupyterlab_lightcone.application import LightconeApp


def mcp_serverapp(*apps):
    """A Jupyter server whose MCP extension has these apps loaded."""
    return SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={"jupyter_server_mcp": apps}))


def started(server):
    """An MCP extension app that has started this FastMCP server."""
    return SimpleNamespace(mcp_server_instance=SimpleNamespace(mcp=server))


async def test_a_connecting_agent_receives_the_instructions():
    server = FastMCP("Jupyter MCP Server")
    assert add_server_instructions(mcp_serverapp(started(server)))
    async with Client(server) as client:
        assert client.initialize_result.instructions == SERVER_INSTRUCTIONS


def test_instructions_another_package_set_are_kept_and_ours_added_once():
    server = FastMCP("Jupyter MCP Server", instructions="Notebook tools act on the active notebook.")
    serverapp = mcp_serverapp(started(server))
    add_server_instructions(serverapp)
    add_server_instructions(serverapp)
    assert server.instructions == f"Notebook tools act on the active notebook.\n\n{SERVER_INSTRUCTIONS}"


def test_without_a_running_mcp_server_nothing_is_instructed():
    assert not add_server_instructions(SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={})))
    assert not add_server_instructions(mcp_serverapp())
    # The MCP extension failed to start, or was stopped.
    assert not add_server_instructions(mcp_serverapp(SimpleNamespace(mcp_server_instance=None)))


async def test_an_mcp_server_started_after_lightcone_still_receives_them():
    """Jupyter Server starts extensions concurrently, in an order this extension does not control."""
    mcp_app = SimpleNamespace(mcp_server_instance=None)
    app = SimpleNamespace(log=Mock())

    async def start_mcp():
        mcp_app.mcp_server_instance = SimpleNamespace(mcp=FastMCP("Jupyter MCP Server"))
        await asyncio.sleep(0.01)  # binding its port

    await asyncio.gather(
        LightconeApp._start_jupyter_server_extension(app, mcp_serverapp(mcp_app)),
        start_mcp(),
    )
    assert mcp_app.mcp_server_instance.mcp.instructions == SERVER_INSTRUCTIONS
    app.log.warning.assert_not_called()
