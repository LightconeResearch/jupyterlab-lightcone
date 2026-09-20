"""Agents start in the project that owns their chat, wherever the chat is stored."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


@pytest.fixture
def root(tmp_path):
    (tmp_path / "project" / "chats").mkdir(parents=True)
    (tmp_path / "project" / "astra.yaml").write_text("name: test\n")
    (tmp_path / "loose").mkdir()
    return tmp_path


def _server(*apps):
    return SimpleNamespace(extension_manager=SimpleNamespace(
        extension_apps={"jupyter_ai_persona_manager": set(apps)}
    ))


@pytest.mark.parametrize("chat, expected", [
    ("project/chats/talk.chat", "project"),
    ("project/talk.chat", "project"),
    ("loose/talk.chat", "loose"),
])
def test_sessions_start_at_the_project_root_or_stay_in_a_loose_chat_folder(root, chat, expected):
    pytest.importorskip("jupyter_ai_persona_manager")
    from jupyterlab_lightcone.agent_workspace import PersonaManager

    # Skip the constructor, which loads personas and needs a running server.
    manager = PersonaManager.__new__(PersonaManager)
    manager.root_dir = str(root)
    manager.chat = SimpleNamespace(get_path=lambda: chat)
    assert Path(manager.get_chat_dir()) == root / expected


def test_the_project_manager_is_selected_and_existing_manager_config_still_applies():
    extension = pytest.importorskip("jupyter_ai_persona_manager.extension")
    from traitlets.config import Config
    from jupyterlab_lightcone.agent_workspace import PersonaManager, select_project_persona_manager

    app = extension.PersonaManagerExtension(
        config=Config({"PersonaManager": {"default_persona_id": "deployment-choice"}})
    )
    assert select_project_persona_manager(_server(app)) is True
    assert app.persona_manager_class is PersonaManager
    assert app._default_persona_id() == "deployment-choice"


def test_a_deployment_list_setting_is_applied_once(root):
    """The subclass shares the base class's config section name."""
    pytest.importorskip("jupyter_ai_persona_manager")
    from traitlets.config import Config
    from jupyterlab_lightcone.agent_workspace import PersonaManager

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
    pytest.importorskip("jupyter_ai_persona_manager")
    from jupyterlab_lightcone import projects
    from jupyterlab_lightcone.agent_workspace import PersonaManager

    def denied(*args, **kwargs):
        raise PermissionError("astra.yaml is not readable")

    monkeypatch.setattr(projects.Path, "is_file", denied)
    manager = PersonaManager.__new__(PersonaManager)
    manager.root_dir = str(root)
    manager.chat = SimpleNamespace(get_path=lambda: "project/chats/talk.chat")
    manager.log = logging.getLogger("test")
    assert Path(manager.get_chat_dir()) == root / "project" / "chats"


def test_a_deployment_configured_manager_is_left_alone():
    extension = pytest.importorskip("jupyter_ai_persona_manager.extension")
    from jupyter_ai_persona_manager import PersonaManager as Upstream
    from jupyterlab_lightcone.agent_workspace import select_project_persona_manager

    class Custom(Upstream):
        pass

    app = extension.PersonaManagerExtension(persona_manager_class=Custom)
    assert select_project_persona_manager(_server(app)) is False
    assert app.persona_manager_class is Custom


def test_a_server_without_the_persona_manager_extension_is_left_alone():
    pytest.importorskip("jupyter_ai_persona_manager")
    from jupyterlab_lightcone.agent_workspace import select_project_persona_manager

    server = SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={}))
    assert select_project_persona_manager(server) is False


def test_the_extension_loads_without_jupyter_ai(monkeypatch):
    from jupyterlab_lightcone.application import LightconeApp

    # A None entry makes the import fail, as it does when Jupyter AI is absent.
    monkeypatch.setitem(sys.modules, "jupyter_ai_persona_manager", None)
    monkeypatch.delitem(sys.modules, "jupyterlab_lightcone.agent_workspace", raising=False)
    LightconeApp._root_agents_in_projects(SimpleNamespace(serverapp=None, log=None))
