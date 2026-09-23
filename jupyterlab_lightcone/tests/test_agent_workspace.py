"""Agents start in the project their chat belongs to, wherever the chat is stored."""
import asyncio
import logging
from pathlib import Path
import sys
from types import SimpleNamespace

from jupyter_ai_persona_manager import PersonaManager as Upstream, extension
from jupyter_ai_persona_manager.base_persona import BasePersona, PersonaDefaults
from jupyterlab_chat.models import Message
import pytest

from jupyterlab_lightcone import agent_workspace, comments, sessions
from jupyterlab_lightcone.agent_workspace import (
    PersonaManager,
    comment_ids,
    select_project_persona_manager,
    session_activity,
)
from jupyterlab_lightcone.projects import CHAT_PROJECT, CURRENT_PROJECT


@pytest.fixture
def root(tmp_path):
    (tmp_path / "project" / "chats").mkdir(parents=True)
    (tmp_path / "project" / "astra.yaml").write_text("name: test\n")
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "astra.yaml").write_text("name: other\n")
    (tmp_path / "loose").mkdir()
    return tmp_path


def _server(*apps):
    return SimpleNamespace(extension_manager=SimpleNamespace(
        extension_apps={"jupyter_ai_persona_manager": set(apps)}
    ))


class Chat:
    """The parts of a Jupyter Chat document the manager and its personas touch."""

    def __init__(self, path, metadata=None):
        self.path = path
        self.metadata = dict(metadata or {})
        self.users = []
        self.messages = []

    def get_id(self):
        return f"id:{self.path}"

    def get_path(self):
        return self.path

    def get_metadata(self):
        return dict(self.metadata)

    def set_metadata(self, name, value):
        self.metadata[name] = value

    def set_user(self, user):
        self.users.append(user)

    def add_message(self, message):
        self.messages.append(message)
        return f"m{len(self.messages)}"

    def update_message(self, message, append=False):
        self.messages.append(message)


def _manager(root, chat, current=None):
    """A manager on a server whose browser reported `current`, without loading personas."""
    parent = extension.PersonaManagerExtension()
    parent.serverapp = SimpleNamespace(web_app=SimpleNamespace(settings={CURRENT_PROJECT: current}))
    # Skip the constructor, which loads personas and needs a running server.
    manager = PersonaManager.__new__(PersonaManager)
    manager.parent = parent
    manager.root_dir = str(root)
    manager.chat = chat if isinstance(chat, Chat) else Chat(chat)
    manager.log = logging.getLogger("test")
    return manager


def _report(manager, current):
    manager.parent.serverapp.web_app.settings[CURRENT_PROJECT] = current


@pytest.mark.parametrize("chat, expected", [
    ("project/chats/talk.chat", "project"),
    ("project/talk.chat", "project"),
    ("loose/talk.chat", "loose"),
])
def test_sessions_start_at_the_project_root_or_stay_in_a_loose_chat_folder(root, chat, expected):
    manager = _manager(root, chat)
    assert Path(manager.get_chat_dir()) == root / expected
    assert manager.chat.metadata == {}


def test_a_chat_stored_in_a_project_ignores_the_current_project(root):
    manager = _manager(root, "project/chats/talk.chat", current="other/astra.yaml")
    assert Path(manager.get_chat_dir()) == root / "project"
    assert manager.chat.metadata == {}


@pytest.mark.parametrize("chat", ["talk.chat", "loose/talk.chat"])
def test_a_chat_outside_every_project_joins_the_current_one_and_keeps_it(root, chat):
    """However it was created, the chat starts in the project the user is in."""
    manager = _manager(root, chat, current="project/astra.yaml")
    assert Path(manager.get_chat_dir()) == root / "project"
    assert manager.chat.metadata == {CHAT_PROJECT: "project/astra.yaml"}
    # Moving on to another project, or leaving every project, keeps the conversation's.
    for current in ("other/astra.yaml", None):
        _report(manager, current)
        assert Path(manager.get_chat_dir()) == root / "project"
    assert manager.chat.metadata == {CHAT_PROJECT: "project/astra.yaml"}


def test_a_recorded_project_that_is_gone_is_replaced_by_the_current_one(root):
    chat = Chat("talk.chat", {CHAT_PROJECT: "removed/astra.yaml"})
    manager = _manager(root, chat)
    assert Path(manager.get_chat_dir()) == root
    assert chat.metadata == {CHAT_PROJECT: "removed/astra.yaml"}
    _report(manager, "other/astra.yaml")
    assert Path(manager.get_chat_dir()) == root / "other"
    assert chat.metadata == {CHAT_PROJECT: "other/astra.yaml"}


def test_a_manager_outside_a_running_server_uses_only_the_chat(root):
    """No parent application means no reported project, not an error."""
    manager = PersonaManager.__new__(PersonaManager)
    manager.root_dir = str(root)
    manager.chat = Chat("talk.chat")
    assert Path(manager.get_chat_dir()) == root


def test_the_project_manager_is_selected_and_existing_manager_config_still_applies():
    from traitlets.config import Config

    app = extension.PersonaManagerExtension(
        config=Config({"PersonaManager": {"default_persona_id": "deployment-choice"}})
    )
    assert select_project_persona_manager(_server(app)) is True
    assert app.persona_manager_class is PersonaManager
    assert app._default_persona_id() == "deployment-choice"


def test_a_deployment_list_setting_is_applied_once(root):
    """The subclass shares the base class's config section name."""
    from traitlets.config import Config

    config = Config()
    config.PersonaManager.builtin_mcp_servers.append(
        {"type": "http", "name": "deployment", "url": "http://localhost/mcp", "headers": []}
    )
    manager = PersonaManager.__new__(PersonaManager)
    manager._load_config(config)
    names = [server["name"] for server in manager.builtin_mcp_servers]
    assert names.count("deployment") == 1


def test_an_unreadable_parent_still_yields_a_working_directory(root, monkeypatch):
    """Upstream's version cannot fail; a chat must not lose its personas."""
    from jupyterlab_lightcone import projects

    def denied(*args, **kwargs):
        raise PermissionError("astra.yaml is not readable")

    monkeypatch.setattr(projects.Path, "is_file", denied)
    manager = _manager(root, "project/chats/talk.chat", current="project/astra.yaml")
    assert Path(manager.get_chat_dir()) == root / "project" / "chats"


def test_a_deployment_configured_manager_is_left_alone():
    class Custom(Upstream):
        pass

    app = extension.PersonaManagerExtension(persona_manager_class=Custom)
    assert select_project_persona_manager(_server(app)) is False
    assert app.persona_manager_class is Custom


def test_a_server_without_the_persona_manager_extension_is_left_alone():
    server = SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={}))
    assert select_project_persona_manager(server) is False


def test_the_extension_loads_without_jupyter_ai(monkeypatch):
    from jupyterlab_lightcone.application import LightconeApp

    # A None entry makes the import fail, as it does when Jupyter AI is absent.
    monkeypatch.setitem(sys.modules, "jupyter_ai_persona_manager", None)
    monkeypatch.delitem(sys.modules, "jupyterlab_lightcone.agent_workspace", raising=False)
    LightconeApp._root_agents_in_projects(SimpleNamespace(serverapp=None, log=None))


# --- comments and activity ----------------------------------------------------


class EchoPersona(BasePersona):
    """A real persona, so upstream's processing boundary runs around ours."""

    @property
    def defaults(self):
        return PersonaDefaults(name="Echo", description="Records its prompts.", avatar_path="", system_prompt="")

    async def process_message(self, message):
        self.prompts.append(message.body)
        gate = self.gates.get(message.id)
        if gate is not None:
            await gate.wait()


def _draft(text, record="outputs.hubble_diagram"):
    return {
        "text": text,
        "target": {"kind": "record", "path": "project/astra.yaml", "record": record, "universe": "baseline",
                   "message": None, "version": {"commit": None, "key": None, "hash": None, "label": "a889877"}},
        "anchor": {"type": "point", "x": 42, "y": 31, "startLine": None, "startCol": None, "endLine": None,
                   "endCol": None, "quote": None, "prefix": None, "page": None},
    }


@pytest.fixture
def pending(root):
    """Two pending comments on the project's figure, after one already sent."""
    project = root / "project"
    (project / "results" / "baseline").mkdir(parents=True)
    (project / "results" / "baseline" / "hubble_diagram.png").write_bytes(b"png")
    listing = []
    for text in ("Earlier", "The legend covers the high-redshift points.", "Second"):
        listing.append(comments.new_comment(comments.validate_draft(_draft(text)), "researcher", listing))
    listing[0].update(status="sent", sentWith={"chat": "project/chats/old.chat", "message": "m0"})
    comments.renumber(listing)
    comments.write_store(comments.store_path(project), listing)
    return listing


def _routing_manager(root, chat, current=None):
    """A manager whose scheduled tasks the test can await."""
    manager = _manager(root, chat, current)
    loop = asyncio.get_running_loop()
    manager.tasks = []
    manager.event_loop = SimpleNamespace(
        create_task=lambda coroutine: manager.tasks.append(loop.create_task(coroutine)) or manager.tasks[-1]
    )
    persona = EchoPersona(parent=manager, chat=manager.chat)
    persona.prompts, persona.gates = [], {}
    manager._personas = {persona.id: persona}
    return manager, persona


def _message(persona_id, ids=None, body="Fix the legend.", identifier="m1"):
    metadata = {"to_persona": persona_id}
    if ids is not None:
        metadata["lightcone"] = {"comments": ids}
    return Message(body=body, id=identifier, time=0.0, sender="user", metadata=metadata)


def _activity(manager):
    return session_activity(manager.parent.serverapp.web_app)


async def _settled(manager, state):
    for _ in range(100):
        if _activity(manager).get("project/chats/talk.chat", {}).get("state") == state:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"The session never became {state}.")


@pytest.mark.parametrize("metadata, expected", [
    (None, []),
    ({}, []),
    ({"lightcone": {"comments": ["a", 1, "b"]}}, ["a", "b"]),
    ({"lightcone": {"comments": "a"}}, []),
    ({"lightcone": []}, []),
])
def test_comment_ids_come_from_the_lightcone_metadata(metadata, expected):
    assert comment_ids(metadata) == expected


async def test_pending_comments_reach_the_persona_and_never_the_chat(root, pending):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    earlier, first, second = pending
    manager.on_chat_message("chat", _message(persona.id, [first["id"], earlier["id"], "missing"]))
    await asyncio.gather(*manager.tasks)
    assert persona.prompts == ["\n".join([
        "Fix the legend.",
        "",
        "Comments on this project (1):",
        '① outputs.hubble_diagram (results/baseline/hubble_diagram.png, version a889877) — point at 42% across, 31% down: "The legend covers the high-redshift points."',
    ])]
    # The chat file keeps the user's own words; the block lives only in the persona's copy.
    assert manager.chat.messages == []
    after = {comment["id"]: comment for comment in comments.read_store(comments.store_path(root / "project"))}
    assert after[first["id"]]["status"] == "sent"
    assert after[first["id"]]["sentWith"] == {"chat": "project/chats/talk.chat", "message": "m1"}
    assert after[earlier["id"]]["sentWith"] == {"chat": "project/chats/old.chat", "message": "m0"}
    assert after[second["id"]]["status"] == "pending" and after[second["id"]]["label"] == 1


async def test_a_message_without_comments_is_routed_unchanged(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    manager.on_chat_message("chat", _message(persona.id))
    await asyncio.gather(*manager.tasks)
    assert persona.prompts == ["Fix the legend."]
    assert not (root / "project" / ".lightcone").exists()


async def test_a_broken_store_still_routes_the_original_message(root, caplog):
    store = comments.store_path(root / "project")
    store.parent.mkdir()
    store.write_bytes(b"\xff")
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    with caplog.at_level(logging.WARNING, logger="test"):
        manager.on_chat_message("chat", _message(persona.id, ["x"]))
        await asyncio.gather(*manager.tasks)
    assert persona.prompts == ["Fix the legend."]
    assert "could not be delivered" in caplog.text
    assert store.read_bytes() == b"\xff"


async def test_comments_need_a_project_to_come_from(root, caplog):
    manager, persona = _routing_manager(root, "loose/talk.chat")
    with caplog.at_level(logging.WARNING, logger="test"):
        manager.on_chat_message("chat", _message(persona.id, ["x"]))
        await asyncio.gather(*manager.tasks)
    assert persona.prompts == ["Fix the legend."]
    assert "no ASTRA project" in caplog.text


async def test_a_message_to_an_unknown_persona_is_not_routed(root):
    manager, _ = _routing_manager(root, "project/chats/talk.chat")
    manager.on_chat_message("chat", _message("jupyter-ai-personas::other::Persona"))
    manager.on_chat_message("chat", Message(body="?", id="m2", time=0.0, sender="user"))
    assert manager.tasks == []
    assert _activity(manager) == {}


async def test_the_session_is_working_while_the_persona_replies(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    persona.gates["m1"] = asyncio.Event()
    manager.on_chat_message("chat", _message(persona.id))
    await _settled(manager, "working")
    working = _activity(manager)["project/chats/talk.chat"]
    assert working["persona"] == persona.id
    assert working["since"].endswith("+00:00")
    persona.gates["m1"].set()
    await asyncio.gather(*manager.tasks)
    idle = _activity(manager)["project/chats/talk.chat"]
    assert idle == {"state": "idle", "persona": persona.id, "since": idle["since"]}
    assert idle["since"] >= working["since"]


async def test_the_session_stays_working_until_every_message_is_answered(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    persona.gates = {"m1": asyncio.Event(), "m2": asyncio.Event()}
    manager.on_chat_message("chat", _message(persona.id, identifier="m1"))
    manager.on_chat_message("chat", _message(persona.id, identifier="m2"))
    await _settled(manager, "working")
    persona.gates["m1"].set()
    await manager.tasks[0]
    assert _activity(manager)["project/chats/talk.chat"]["state"] == "working"
    persona.gates["m2"].set()
    await manager.tasks[1]
    assert _activity(manager)["project/chats/talk.chat"]["state"] == "idle"
    assert persona.prompts == ["Fix the legend.", "Fix the legend."]


async def test_a_crashed_boundary_still_leaves_the_session_idle(root, monkeypatch):
    async def explode(persona, message):
        raise RuntimeError("boundary gone")

    monkeypatch.setattr(agent_workspace, "process_safely", explode)
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    manager.on_chat_message("chat", _message(persona.id))
    with pytest.raises(RuntimeError):
        await manager.tasks[0]
    assert _activity(manager)["project/chats/talk.chat"]["state"] == "idle"


async def test_a_manager_outside_a_running_server_still_routes(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    manager.parent = None
    manager.on_chat_message("chat", _message(persona.id))
    await asyncio.gather(*manager.tasks)
    assert persona.prompts == ["Fix the legend."]


def test_session_activity_is_one_shared_map():
    web_app = SimpleNamespace(settings={})
    activity = session_activity(web_app)
    assert activity == {}
    activity["a.chat"] = {"state": "idle", "persona": "p", "since": "now"}
    assert session_activity(web_app) is activity
    # The session listing reads the very map the manager writes.
    assert web_app.settings[sessions.SESSION_ACTIVITY] is activity
