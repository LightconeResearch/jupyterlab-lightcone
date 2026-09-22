"""The optional tool bridge must never fall back to broadcasting commands."""
from contextvars import ContextVar
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from jupyterlab_lightcone.agent_tools import lightcone_open_element


@pytest.fixture
def settings(monkeypatch):
    """The running server's settings, where the browser reports its current project."""
    from jupyter_server.serverapp import ServerApp

    settings = {"jupyter-ai": {"persona-managers": {}}}
    monkeypatch.setattr(
        ServerApp, "instance", lambda: SimpleNamespace(web_app=SimpleNamespace(settings=settings))
    )
    return settings


@pytest.fixture
def manager(settings, tmp_path):
    """The calling chat lives in a subfolder of its project, not beside astra.yaml."""
    (tmp_path / "project" / "chats").mkdir(parents=True)
    (tmp_path / "project" / "astra.yaml").write_text("name: test\n")
    (tmp_path / "loose").mkdir()
    metadata = {}
    manager = SimpleNamespace(
        root_dir=str(tmp_path),
        chat_path="project/chats/talk.chat",
        personas={},
        chat=SimpleNamespace(
            metadata=metadata,
            get_metadata=lambda: dict(metadata),
            set_metadata=metadata.__setitem__,
        ),
    )
    manager.get_chat_path = lambda relative=False: manager.chat_path
    settings["jupyter-ai"]["persona-managers"]["origin-chat"] = manager
    return manager


@pytest.fixture
def bridge(monkeypatch, manager):
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
    result = await lightcone_open_element("outputs.plot")
    assert result["success"] is False
    assert "NO_ACTIVE_CLIENT" in result["error"]
    bridge.execute_command.assert_not_called()


async def test_project_comes_from_the_calling_chat_not_the_agent(bridge):
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("decisions.method")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is True
    bridge.execute_command.assert_awaited_once_with(
        "jupyterlab_lightcone:open-element",
        {"target": "decisions.method", "entrypoint": "project/astra.yaml"},
    )


@pytest.mark.parametrize("chat_path", ["loose/talk.chat", "talk.chat"])
async def test_a_chat_outside_every_project_addresses_the_current_one(bridge, manager, settings, chat_path):
    """A chat opened from Jupyter Chat's own sidebar or launcher still has a project."""
    from jupyterlab_lightcone.projects import CHAT_PROJECT, CURRENT_PROJECT

    manager.chat_path = chat_path
    settings[CURRENT_PROJECT] = "project/astra.yaml"
    token = bridge.target_client_id.set("origin-browser")
    try:
        await lightcone_open_element("decisions.method")
    finally:
        bridge.target_client_id.reset(token)
    bridge.execute_command.assert_awaited_once_with(
        "jupyterlab_lightcone:open-element",
        {"target": "decisions.method", "entrypoint": "project/astra.yaml"},
    )
    # The same record the agent's working directory is chosen from.
    assert manager.chat.metadata == {CHAT_PROJECT: "project/astra.yaml"}


@pytest.mark.parametrize("chat_path", ["loose/talk.chat", "talk.chat"])
async def test_chat_without_any_project_is_rejected(bridge, manager, chat_path):
    manager.chat_path = chat_path
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("decisions.method")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "NO_PROJECT" in result["error"]
    bridge.execute_command.assert_not_called()


async def test_timeout_does_not_claim_the_tab_failed_to_open(bridge):
    bridge.execute_command.return_value = {
        "success": False, "error": "Command timed out after 10 seconds"
    }
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("outputs.plot")
    finally:
        bridge.target_client_id.reset(token)
    assert result["status"] == "unconfirmed"


@pytest.fixture
def persona(bridge, manager, monkeypatch):
    """Model the persisted chat contract without installing optional AI packages."""
    import sys
    from dataclasses import asdict, dataclass
    from unittest.mock import Mock

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
    manager.personas["agent"] = agent
    bridge.execute_command.return_value = {"success": True, "result": {
        "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline", "label": "Figure"
    }}
    return agent


async def test_preview_is_a_persisted_persona_mime_message_and_retries_reuse_it(bridge, persona):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    token = bridge.target_client_id.set("origin-browser")
    try:
        first = await lightcone_preview_element("outputs.figure")
        second = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert first == {"success": True, "message_id": "card", "reused": False}
    assert second == {"success": True, "message_id": "card", "reused": True}
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
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "NO_ACTIVE_PERSONA" in result["error"]
    persona.chat.add_message.assert_not_called()


async def test_preview_does_not_publish_when_the_browser_rejects_the_target(bridge, persona):
    from jupyterlab_lightcone.agent_tools import lightcone_preview_element

    bridge.execute_command.return_value = {"success": False, "error": "Unknown ASTRA target"}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("outputs.missing")
    finally:
        bridge.target_client_id.reset(token)
    assert result["error"] == "Unknown ASTRA target"
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
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "INVALID_PREVIEW_RESPONSE" in result["error"]
    persona.chat.add_message.assert_not_called()
