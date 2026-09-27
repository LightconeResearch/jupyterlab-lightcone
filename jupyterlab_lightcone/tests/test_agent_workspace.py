"""Agents start in the project their chat belongs to, wherever the chat is stored."""
import asyncio
import logging
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from jupyter_ai_persona_manager import PersonaManager as Upstream, extension
from jupyter_ai_persona_manager.base_persona import BasePersona, PersonaDefaults
from jupyterlab_chat.models import Message
import pytest
from traitlets.config import Config

from jupyterlab_lightcone import agent_defaults, comments, projects
from jupyterlab_lightcone.agent_workspace import PersonaManager, comment_ids, delivers_comments, select_project_persona_manager
from jupyterlab_lightcone.projects import CHAT_PROJECT, CURRENT_PROJECT


@pytest.fixture
def root(tmp_path):
    (tmp_path / "project" / "chats").mkdir(parents=True)
    (tmp_path / "project" / "universes").mkdir()
    # A spec the engine's planner reads: comment delivery names an output's file through it.
    (tmp_path / "project" / "astra.yaml").write_text(
        'version: "1.0"\nname: test\ninputs: []\noutputs:\n  - id: hubble_diagram\n    type: figure\n'
        "    format: png\n    recipe:\n      command: python fig.py --out {{output}}\n"
    )
    (tmp_path / "project" / "universes" / "baseline.yaml").write_text("id: baseline\n")
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "astra.yaml").write_text("name: other\n")
    (tmp_path / "loose").mkdir()
    return tmp_path


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

    def get_messages(self):
        return list(self.messages)

    def update_message(self, message, append=False):
        self.messages.append(message)


def _manager(root, chat, current=None):
    """A manager on a server whose browser reported `current`, without loading personas.

    Upstream's constructor loads persona classes and needs a running server,
    so the manager is built bare and given the upstream attributes it reads:
    `parent` (the extension app, whose `serverapp` holds the settings),
    `root_dir`, `chat`, `log`, and the persona map behind `personas`.
    """
    parent = extension.PersonaManagerExtension()
    parent.serverapp = SimpleNamespace(web_app=SimpleNamespace(settings={CURRENT_PROJECT: current}))
    manager = PersonaManager.__new__(PersonaManager)
    manager.parent = parent
    manager.root_dir = str(root)
    manager.chat = chat if isinstance(chat, Chat) else Chat(chat)
    manager.log = logging.getLogger("test")
    manager._personas = {}
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


def test_the_pure_lookup_never_writes_and_the_join_records_once(root):
    manager = _manager(root, "loose/talk.chat", current="project/astra.yaml")
    assert projects.chat_project(manager) is None
    assert manager.chat.metadata == {}
    assert projects.join_project(manager, "project/astra.yaml") == root / "project"
    assert projects.chat_project(manager) == root / "project"
    assert manager.chat.metadata == {CHAT_PROJECT: "project/astra.yaml"}


def _server(*apps):
    return SimpleNamespace(extension_manager=SimpleNamespace(
        extension_apps={"jupyter_ai_persona_manager": set(apps)}
    ))


def test_a_manager_outside_a_running_server_uses_only_the_chat(root):
    """No parent application means no reported project, not an error."""
    manager = PersonaManager.__new__(PersonaManager)
    manager.root_dir = str(root)
    manager.chat = Chat("talk.chat")
    manager.log = logging.getLogger("test")
    assert Path(manager.get_chat_dir()) == root


def test_the_project_manager_is_selected_and_existing_manager_config_still_applies():
    """The subclass keeps the upstream class name, so the extension's
    `default_persona_id` lookup, keyed by the class name, still honours a
    deployment's `c.PersonaManager` settings."""
    app = extension.PersonaManagerExtension(
        config=Config({"PersonaManager": {"default_persona_id": "deployment-choice"}})
    )
    assert select_project_persona_manager(_server(app)) is True
    assert app.persona_manager_class is PersonaManager
    assert app._default_persona_id() == "deployment-choice"


def test_a_deployment_that_names_this_manager_uses_it():
    app = extension.PersonaManagerExtension(persona_manager_class=PersonaManager)
    assert select_project_persona_manager(_server(app)) is True
    assert app.persona_manager_class is PersonaManager


def test_a_deployment_configured_manager_is_left_alone():
    class Custom(Upstream):
        pass

    app = extension.PersonaManagerExtension(persona_manager_class=Custom)
    assert select_project_persona_manager(_server(app)) is False
    assert app.persona_manager_class is Custom


def test_a_server_without_the_persona_manager_extension_is_left_alone():
    server = SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={}))
    assert select_project_persona_manager(server) is False


def test_the_extension_loads_without_jupyter_ai():
    # A fresh interpreter ensures no earlier test imported the application or
    # persona event module before Jupyter AI became unavailable.
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
from types import SimpleNamespace
sys.modules["jupyter_ai_persona_manager"] = None
from jupyterlab_lightcone.application import LightconeApp
from jupyterlab_lightcone.agent_activity import watch_persona_activity
LightconeApp._root_agents_in_projects(SimpleNamespace(serverapp=None, log=None))
server = SimpleNamespace(web_app=SimpleNamespace(settings={}))
LightconeApp._configure_agents(SimpleNamespace(serverapp=server, log=None))
assert server.web_app.settings["page_config_data"]["lightconeCommentDelivery"] == "message"
watch_persona_activity(None)
"""],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_a_failing_selection_leaves_the_extension_loading(monkeypatch, caplog):
    from jupyterlab_lightcone import agent_workspace
    from jupyterlab_lightcone.application import LightconeApp

    def broken(serverapp):
        raise RuntimeError("incompatible Jupyter AI")

    monkeypatch.setattr(agent_workspace, "select_project_persona_manager", broken)
    log = logging.getLogger("lightcone-test")
    with caplog.at_level(logging.WARNING, logger="lightcone-test"):
        LightconeApp._root_agents_in_projects(SimpleNamespace(serverapp=None, log=log))
    assert "Could not root Jupyter AI agents" in caplog.text


def test_a_deployment_list_setting_is_applied_once(root):
    """The subclass shares the base class's config section name."""
    config = Config()
    config.PersonaManager.builtin_mcp_servers.append(
        {"type": "http", "name": "deployment", "url": "http://localhost/mcp", "headers": []}
    )
    manager = _manager(root, "project/chats/talk.chat")
    manager.update_config(config)
    names = [server["name"] for server in manager.builtin_mcp_servers]
    assert names.count("deployment") == 1


def test_an_unreadable_parent_still_yields_a_working_directory(root, monkeypatch):
    """Upstream's version cannot fail; a chat must not lose its personas."""

    def denied(root, directory):
        raise PermissionError("astra.yaml is not readable")

    monkeypatch.setattr(projects, "owning_project", denied)
    manager = _manager(root, "project/chats/talk.chat", current="project/astra.yaml")
    assert Path(manager.get_chat_dir()) == root / "project" / "chats"


# --- agent routing -------------------------------------------------------


class EchoPersona(BasePersona):
    """A real persona, so upstream's processing boundary runs around ours."""

    @property
    def defaults(self):
        return PersonaDefaults(name="Echo", description="Records its prompts.", avatar_path="", system_prompt="")

    async def process_message(self, message):
        self.received.append(message)
        gate = self.gates.get(message.id)
        if gate is not None:
            await gate.wait()

    @property
    def prompts(self):
        return [message.body for message in self.received]


def _routing_manager(root, chat, current=None):
    """A manager whose scheduled tasks the test can await, with one real persona."""
    manager = _manager(root, chat, current)
    loop = asyncio.get_running_loop()
    manager.tasks = []
    manager.event_loop = SimpleNamespace(
        create_task=lambda coroutine: manager.tasks.append(loop.create_task(coroutine)) or manager.tasks[-1]
    )
    persona = _persona(manager)
    manager._personas = {persona.id: persona}
    return manager, persona


def _persona(manager):
    persona = EchoPersona(parent=manager, chat=manager.chat)
    persona.received, persona.gates = [], {}
    return persona


async def _settled(manager):
    """Await every task the manager scheduled, including those a task scheduled itself."""
    done = set()
    while True:
        pending = [task for task in manager.tasks if task not in done]
        if not pending:
            return
        await asyncio.gather(*pending)
        done.update(pending)


def _message(persona_id, ids=None, body="Fix the legend.", identifier="m1"):
    metadata = {"to_persona": persona_id}
    if ids is not None:
        metadata["lightcone"] = {"comments": ids}
    return Message(body=body, id=identifier, time=0.0, sender="user", metadata=metadata)


async def test_an_addressed_message_is_routed_unchanged(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    manager.on_chat_message("chat", _message(persona.id))
    await _settled(manager)
    assert persona.prompts == ["Fix the legend."]
    assert persona.received[0].metadata["to_persona"] == persona.id
    assert agent_defaults.read_project_agent(root / "project") == persona.id
    assert not comments.store_path(root / "project").exists()


async def test_a_message_to_an_unknown_persona_is_not_routed(root):
    manager, _ = _routing_manager(root, "project/chats/talk.chat")
    manager.on_chat_message("chat", _message("jupyter-ai-personas::other::Persona"))
    manager.on_chat_message("chat", Message(body="?", id="m2", time=0.0, sender="user"))
    assert manager.tasks == []


def _unaddressed(identifier="m9", persona_id=None):
    return Message(body="And the residuals?", id=identifier, time=0.0, sender="user",
                   metadata={"to_persona": persona_id})


async def test_an_unaddressed_message_goes_to_the_agent_this_chat_last_named(root):
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    other = _persona(manager)
    other_id = "jupyter-ai-personas::other::Echo"
    manager._personas[other_id] = other
    # The chat named the first persona last; a reply from a persona does not count.
    manager.chat.messages = [
        _message(other_id, identifier="m1"),
        _message(persona.id, identifier="m2"),
        Message(body="Done.", id="m3", time=0.0, sender=other_id, metadata={"to_persona": other_id}),
    ]
    for identifier, named in (("m4", None), ("m5", "jupyter-ai-personas::gone::Persona")):
        manager.on_chat_message("chat", _unaddressed(identifier, named))
    await _settled(manager)
    assert persona.prompts == ["And the residuals?", "And the residuals?"]
    # Upstream received copies addressed to the agent that answered.
    assert [message.metadata["to_persona"] for message in persona.received] == [persona.id, persona.id]
    assert other.prompts == []


async def test_an_unaddressed_message_in_a_fresh_chat_goes_to_the_projects_agent(root):
    manager, persona = _routing_manager(root, "project/chats/new.chat")
    agent_defaults.write_project_agent(root / "project", persona.id)
    manager.on_chat_message("chat", _unaddressed())
    await _settled(manager)
    assert persona.prompts == ["And the residuals?"]


async def test_a_recorded_agent_this_chat_does_not_have_is_not_used(root):
    manager, persona = _routing_manager(root, "project/chats/new.chat")
    agent_defaults.write_project_agent(root / "project", "jupyter-ai-personas::gone::Persona")
    manager.on_chat_message("chat", _unaddressed())
    assert manager.tasks == []
    assert persona.prompts == []


async def test_a_failing_persona_does_not_break_routing(root):
    """Upstream's processing boundary reports the failure; the manager's task completes."""
    manager, persona = _routing_manager(root, "project/chats/talk.chat")

    async def explode(message):
        raise RuntimeError("agent gone")

    persona.process_message = explode
    manager.on_chat_message("chat", _message(persona.id))
    await _settled(manager)
    assert all(task.exception() is None for task in manager.tasks)


def test_comments_go_in_the_prompt_only_when_every_manager_is_lightcones():
    assert delivers_comments(_server(extension.PersonaManagerExtension(persona_manager_class=PersonaManager)))

    class Derived(PersonaManager):
        pass

    assert delivers_comments(_server(extension.PersonaManagerExtension(persona_manager_class=Derived)))

    class Custom(Upstream):
        pass

    assert not delivers_comments(_server(extension.PersonaManagerExtension(persona_manager_class=Custom)))
    assert not delivers_comments(_server(extension.PersonaManagerExtension()))
    assert not delivers_comments(_server())


def test_the_extension_tells_the_composer_how_comments_travel(monkeypatch):
    from jupyterlab_lightcone import application
    from jupyterlab_lightcone.application import LightconeApp

    listeners = []
    monkeypatch.setattr(application, "watch_persona_activity", listeners.append)
    for manager_class, expected in ((PersonaManager, "prompt"), (Upstream, "message")):
        server = _server(extension.PersonaManagerExtension(persona_manager_class=manager_class))
        server.web_app = SimpleNamespace(settings={})
        LightconeApp._configure_agents(SimpleNamespace(serverapp=server, log=logging.getLogger("test")))
        assert server.web_app.settings["page_config_data"][comments.COMMENT_DELIVERY] == expected
        assert listeners[-1] is server


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
    await _settled(manager)
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


async def test_a_broken_store_still_routes_the_original_message(root, caplog):
    store = comments.store_path(root / "project")
    store.parent.mkdir()
    store.write_bytes(b"\xff")
    manager, persona = _routing_manager(root, "project/chats/talk.chat")
    with caplog.at_level(logging.WARNING, logger="test"):
        manager.on_chat_message("chat", _message(persona.id, ["x"]))
        await _settled(manager)
    assert persona.prompts == ["Fix the legend."]
    assert "could not be delivered" in caplog.text
    assert store.read_bytes() == b"\xff"


async def test_comments_need_a_project_to_come_from(root, caplog):
    manager, persona = _routing_manager(root, "loose/talk.chat")
    with caplog.at_level(logging.WARNING, logger="test"):
        manager.on_chat_message("chat", _message(persona.id, ["x"]))
        await _settled(manager)
    assert persona.prompts == ["Fix the legend."]
    assert "no ASTRA project" in caplog.text


def test_startup_selects_the_project_manager_before_advertising_comment_delivery(root, monkeypatch):
    from jupyterlab_lightcone import application
    from jupyterlab_lightcone.application import LightconeApp

    monkeypatch.setattr(application, "watch_persona_activity", lambda server: None)
    persona_app = extension.PersonaManagerExtension()
    server = _server(persona_app)
    server.web_app = SimpleNamespace(settings={})
    server.contents_manager = SimpleNamespace(root_dir=str(root))
    app = SimpleNamespace(serverapp=server, log=logging.getLogger("test"))
    app._root_agents_in_projects = lambda: LightconeApp._root_agents_in_projects(app)
    app._configure_agents = lambda: LightconeApp._configure_agents(app)
    app._publish_server_root = lambda: LightconeApp._publish_server_root(app)
    LightconeApp.initialize_settings(app)
    assert persona_app.persona_manager_class is PersonaManager
    assert server.web_app.settings["page_config_data"][comments.COMMENT_DELIVERY] == "prompt"


async def test_comments_without_a_running_server_leave_the_message_unchanged(root, pending):
    manager = PersonaManager.__new__(PersonaManager)
    manager.root_dir = str(root)
    manager.chat = Chat("project/chats/talk.chat")
    manager.log = logging.getLogger("test")
    message = _message("agent", [pending[1]["id"]])
    assert await manager._with_comments(message, [pending[1]["id"]]) is message
    stored = comments.read_store(comments.store_path(root / "project"))
    assert stored[1]["status"] == "pending"
