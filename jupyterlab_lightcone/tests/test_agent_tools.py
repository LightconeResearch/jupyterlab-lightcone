"""The tool bridge must never fall back to broadcasting commands."""
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from jupyter_server_mcp.client_routing import CHAT_ID_HEADER, PERSONA_ID_HEADER, WEB_CLIENT_ID_METADATA_KEY
import pytest

from jupyterlab_lightcone import agent_tools
from jupyterlab_lightcone.agent_tools import lightcone_open_element, lightcone_preview_element


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
    """The MCP request headers and the command bridge, as jupyter-server-mcp provides them in a tool call."""
    from fastmcp.server import dependencies
    from jupyterlab_commands_toolkit import tools

    headers = {CHAT_ID_HEADER: "origin-chat"}
    execute = AsyncMock(return_value={"success": True, "result": {"view": "element"}})
    monkeypatch.setattr(dependencies, "get_http_headers", lambda: headers)
    monkeypatch.setattr(tools, "execute_command", execute)
    return SimpleNamespace(headers=headers, execute_command=execute, target_client_id=tools.target_client_id)


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
    bridge.execute_command.return_value = {"success": False, "error": "Command timed out after 10 seconds"}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_open_element("outputs.plot")
    finally:
        bridge.target_client_id.reset(token)
    assert result["status"] == "unconfirmed"


@pytest.fixture
def persona(bridge, manager):
    """A persona answering the originating browser, whose chat records the cards it publishes.

    Messages are stored the way Jupyter Chat persists them: as plain dicts,
    so the nested MIME model comes back as a dict too.
    """
    bridge.headers[PERSONA_ID_HEADER] = "agent"
    messages = []

    def add_message(message):
        messages.append(SimpleNamespace(**asdict(message), id="card", deleted=False))
        return "card"

    agent = SimpleNamespace(
        id="agent",
        processing_message=SimpleNamespace(id="prompt", metadata={WEB_CLIENT_ID_METADATA_KEY: "origin-browser"}),
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
    assert message.mime_model.data[agent_tools.ASTRA_MIME_TYPE] == {
        "version": 1, "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline"
    }
    assert message.mime_model.data["text/plain"] == message.body


async def test_preview_requires_the_originating_persona_and_browser(bridge, persona):
    token = bridge.target_client_id.set("another-browser")
    try:
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "NO_ACTIVE_PERSONA" in result["error"]
    persona.chat.add_message.assert_not_called()


async def test_preview_does_not_publish_when_the_browser_rejects_the_target(bridge, persona):
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
    bridge.execute_command.return_value = {"success": True, "result": element}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "INVALID_PREVIEW_RESPONSE" in result["error"]
    persona.chat.add_message.assert_not_called()


async def test_preview_of_an_output_pins_the_version_the_browser_named(bridge, persona):
    bridge.execute_command.return_value = {"success": True, "result": {
        "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline",
        "label": "Figure",
        "outputVersion": {"commit": "A889877" + "0" * 33, "key": "SHA256E-s10--abc.png"},
    }}
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is True
    message = persona.chat.add_message.call_args.args[0]
    assert message.mime_model.data[agent_tools.ASTRA_MIME_TYPE]["outputVersion"] == {
        "commit": "a889877" + "0" * 33, "key": "SHA256E-s10--abc.png"
    }


@pytest.mark.parametrize("version", [
    None, "a889877", {"commit": "xyz"}, {"commit": "a88987"}, {"key": "SHA256E-s1--x"},
])
async def test_a_malformed_output_version_pins_nothing(bridge, persona, version):
    bridge.execute_command.return_value = {"success": True, "result": {
        "entrypoint": "project/astra.yaml", "target": "outputs.figure", "universeId": "baseline",
        "label": "Figure", "outputVersion": version,
    }}
    token = bridge.target_client_id.set("origin-browser")
    try:
        await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    payload = persona.chat.add_message.call_args.args[0].mime_model.data[agent_tools.ASTRA_MIME_TYPE]
    assert "outputVersion" not in payload


def test_an_unusable_annex_key_is_dropped_but_the_commit_kept():
    from jupyterlab_lightcone.agent_tools import _card_version

    assert _card_version({"commit": "a889877", "key": "bad key"}) == {"commit": "a889877"}
    assert _card_version({"commit": "a889877", "key": "x/y"}) == {"commit": "a889877"}
    assert _card_version({"commit": "a889877", "key": "k" * 257}) == {"commit": "a889877"}


async def test_preview_rejects_a_persona_from_a_different_chat(bridge, persona):
    persona.chat.get_id = lambda: "another-chat"
    token = bridge.target_client_id.set("origin-browser")
    try:
        result = await lightcone_preview_element("outputs.figure")
    finally:
        bridge.target_client_id.reset(token)
    assert result["success"] is False
    assert "NO_ACTIVE_PERSONA" in result["error"]
    persona.chat.add_message.assert_not_called()
