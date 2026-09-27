"""Agents start in the project their chat belongs to, wherever the chat is stored."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace

from jupyter_ai_persona_manager import PersonaManager as Upstream, extension
import pytest
from traitlets.config import Config

from jupyterlab_lightcone import projects
from jupyterlab_lightcone.agent_workspace import PersonaManager, select_project_persona_manager
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


def test_the_extension_loads_without_jupyter_ai(monkeypatch):
    from jupyterlab_lightcone.application import LightconeApp

    # A None entry makes the import fail, as it does when Jupyter AI is absent.
    monkeypatch.setitem(sys.modules, "jupyter_ai_persona_manager", None)
    monkeypatch.delitem(sys.modules, "jupyterlab_lightcone.agent_workspace", raising=False)
    LightconeApp._root_agents_in_projects(SimpleNamespace(serverapp=None, log=None))


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
