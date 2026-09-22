"""Agents start in the project their chat belongs to, wherever the chat is stored."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace

from jupyter_ai_persona_manager import PersonaManager as Upstream, extension
import pytest

from jupyterlab_lightcone.agent_workspace import PersonaManager, select_project_persona_manager
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
    """The parts of a Jupyter Chat document the manager reads and writes."""

    def __init__(self, path, metadata=None):
        self.path = path
        self.metadata = dict(metadata or {})

    def get_path(self):
        return self.path

    def get_metadata(self):
        return dict(self.metadata)

    def set_metadata(self, name, value):
        self.metadata[name] = value


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
