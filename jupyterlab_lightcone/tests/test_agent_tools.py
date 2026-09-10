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


async def test_uses_middleware_routing_without_chat_binding(bridge):
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


async def test_paper_and_universe_arguments_use_the_browser_contract(bridge):
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element(
            "project/astra.yaml", universe_id="baseline", doi="10.1234/example"
        )
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is True
    bridge.execute_command.assert_awaited_once_with(
        "jupyterlab_lightcone:open-element",
        {
            "entrypoint": "project/astra.yaml", "target": "",
            "universeId": "baseline", "doi": "10.1234/example",
        },
    )


@pytest.fixture
def persona(bridge, monkeypatch):
    """Model the persisted chat contract without installing optional AI packages."""
    import sys
    from dataclasses import asdict, dataclass
    from types import SimpleNamespace
    from unittest.mock import Mock
    from jupyter_server.serverapp import ServerApp

    @dataclass
    class MimeModel:
        data: dict
        metadata: dict | None = None

    @dataclass
    class NewMessage:
        body: str
        sender: str
        mime_model: MimeModel

    models = ModuleType("jupyterlab_chat.models")
    models.MimeModel = MimeModel
    models.NewMessage = NewMessage
    monkeypatch.setitem(sys.modules, "jupyterlab_chat.models", models)
    sys.modules["fastmcp.server.dependencies"].get_http_headers = lambda: {
        "x-jupyter-chat-id": "origin-chat",
        "x-jupyterai-persona-id": "agent",
    }
    messages = []

    def add_message(message):
        messages.append(SimpleNamespace(**asdict(message), id="card", deleted=False))
        return "card"

    agent = SimpleNamespace(
        id="agent",
        processing_message=SimpleNamespace(id="prompt", metadata={"web_client_id": "origin-browser"}),
        chat=SimpleNamespace(
            get_id=lambda: "origin-chat",
            get_messages=lambda: messages,
            add_message=Mock(side_effect=add_message),
        ),
    )
    settings = {"jupyter-ai": {"persona-managers": {"origin-chat": SimpleNamespace(personas={"agent": agent})}}}
    monkeypatch.setattr(ServerApp, "instance", lambda: SimpleNamespace(web_app=SimpleNamespace(settings=settings)))
    bridge.execute_command.return_value = {"success": True, "result": {
        "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline", "label": "Figure"
    }}
    return agent


@pytest.mark.parametrize("universe_id", [None, "baseline"])
async def test_preview_is_a_persisted_persona_mime_message_and_retries_reuse_it(bridge, persona, universe_id):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    token = bridge.target_client_id.set("origin-browser")
    try:
        first = await lightcone_preview_element("project/astra.yaml", "outputs.figure", universe_id)
        second = await lightcone_preview_element("project/astra.yaml", "outputs.figure", universe_id)
    finally:
        bridge.target_client_id.reset(token)
    assert first == {"success": True, "message_id": "card", "reused": False}
    assert second == {"success": True, "message_id": "card", "reused": True}
    bridge.execute_command.assert_awaited_with(
        "jupyterlab_lightcone:resolve-preview",
        {
            "entrypoint": "project/astra.yaml", "target": "outputs.figure",
            **({"universeId": universe_id} if universe_id is not None else {}),
        },
    )
    persona.chat.add_message.assert_called_once()
    message = persona.chat.add_message.call_args.args[0]
    assert message.sender == "agent"
    assert message.mime_model.data["application/vnd.lightcone.astra+json"] == {
        "version": 1, "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline"
    }
    assert message.mime_model.data["text/plain"] == message.body


async def test_preview_requires_the_originating_persona_and_browser(bridge, persona):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    token = bridge.target_client_id.set("another-browser")
    try:
        result = await lightcone_preview_element("project/astra.yaml", "outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "NO_ACTIVE_PERSONA" in result["error"]
    persona.chat.add_message.assert_not_called()


async def test_preview_does_not_publish_when_target_resolution_fails(bridge, persona):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    bridge.execute_command.return_value = {"success": False, "error": "TARGET_NOT_FOUND"}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("other/astra.yaml", "outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["error"] == "TARGET_NOT_FOUND"
    persona.chat.add_message.assert_not_called()


@pytest.mark.parametrize("element", [
    None, [], {},
    {"entrypoint": "project/astra.yaml", "target": "outputs.figure", "label": "Figure"},
    {"entrypoint": "project/astra.yaml", "target": "outputs.figure", "label": "Figure", "universeId": 1},
    {"entrypoint": "project/astra.yaml", "target": "outputs.figure", "label": None, "universeId": None},
])
async def test_malformed_preview_response_does_not_publish(bridge, persona, element):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    bridge.execute_command.return_value = {"success": True, "result": element}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("project/astra.yaml", "outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "INVALID_PREVIEW_RESPONSE" in result["error"]
    persona.chat.add_message.assert_not_called()
