"""The optional tool bridge must never fall back to broadcasting commands."""
from contextvars import ContextVar
from types import ModuleType
from unittest.mock import AsyncMock

import pytest

from jupyterlab_lightcone.agent_tools import lightcone_open_element


@pytest.fixture
def bridge(monkeypatch):
    """Supply only the optional imports, so these tests also run without AI."""
    import sys

    toolkit = ModuleType("jupyterlab_commands_toolkit.tools")
    toolkit.target_client_id = ContextVar("test_client", default=None)
    toolkit.execute_command = AsyncMock(
        return_value={"success": True, "result": {"view": "element"}}
    )
    dependencies = ModuleType("fastmcp.server.dependencies")
    dependencies.get_http_headers = lambda: {"x-jupyter-chat-id": "origin-chat"}
    monkeypatch.setitem(sys.modules, "jupyterlab_commands_toolkit.tools", toolkit)
    monkeypatch.setitem(sys.modules, "fastmcp.server.dependencies", dependencies)
    return toolkit


async def test_missing_browser_never_broadcasts(bridge):
    result = await lightcone_open_element("astra.yaml", "outputs.plot")
    assert result["success"] is False
    assert "NO_ACTIVE_CLIENT" in result["error"]
    bridge.execute_command.assert_not_called()


async def test_uses_middleware_routing_and_origin_chat(bridge):
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("project/astra.yaml", "decisions.method")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is True
    bridge.execute_command.assert_awaited_once_with(
        "jupyterlab_lightcone:open-element",
        {
            "entrypoint": "project/astra.yaml",
            "target": "decisions.method",
            "universeId": None,
            "chatId": "origin-chat",
        },
    )


async def test_timeout_does_not_claim_the_tab_failed_to_open(bridge):
    bridge.execute_command.return_value = {
        "success": False, "error": "Command timed out after 10 seconds"
    }
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("astra.yaml", "outputs.plot")
    finally:
        bridge.target_client_id.reset(token)
    assert result["status"] == "unconfirmed"
