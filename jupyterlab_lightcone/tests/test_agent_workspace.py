"""Agents start in the project that owns their chat, wherever the chat is stored."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from jupyterlab_lightcone.projects import owning_project


@pytest.fixture
def root(tmp_path):
    (tmp_path / "project" / "chats" / "deep").mkdir(parents=True)
    (tmp_path / "project" / "astra.yaml").write_text("name: test\n")
    (tmp_path / "project" / "sub").mkdir()
    (tmp_path / "project" / "sub" / "astra.yaml").write_text("name: nested\n")
    (tmp_path / "loose").mkdir()
    return tmp_path


@pytest.mark.parametrize("directory, expected", [
    ("project", "project"),
    ("project/chats", "project"),
    ("project/chats/deep", "project"),
    ("project/sub", "project/sub"),
    ("loose", None),
    ("", None),
    ("..", None),
])
def test_owning_project_is_the_nearest_ancestor_inside_the_root(root, directory, expected):
    found = owning_project(root, Path(directory))
    assert found == (root / expected if expected else None)


def test_a_specification_above_the_server_root_is_never_used(root):
    assert owning_project(root / "project" / "chats", Path("deep")) is None


def test_astra_yaml_must_be_a_file(root):
    (root / "loose" / "astra.yaml").mkdir()
    assert owning_project(root, Path("loose")) is None


@pytest.mark.parametrize("chat, expected", [
    ("project/chats/talk.chat", "project"),
    ("project/talk.chat", "project"),
    ("project/sub/talk.chat", "project/sub"),
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


def _server(*apps):
    return SimpleNamespace(extension_manager=SimpleNamespace(
        extension_apps={"jupyter_ai_persona_manager": set(apps)}
    ))


def test_the_project_manager_is_selected_and_keeps_the_upstream_config_section():
    extension = pytest.importorskip("jupyter_ai_persona_manager.extension")
    from jupyterlab_lightcone.agent_workspace import PersonaManager, select_project_persona_manager

    app = extension.PersonaManagerExtension()
    assert select_project_persona_manager(_server(app)) is True
    assert app.persona_manager_class is PersonaManager
    # Jupyter AI reads `default_persona_id` from the section named after the class.
    assert PersonaManager.__name__ == "PersonaManager"


def test_a_deployment_configured_manager_is_left_alone():
    extension = pytest.importorskip("jupyter_ai_persona_manager.extension")
    from jupyter_ai_persona_manager import PersonaManager as Upstream
    from jupyterlab_lightcone.agent_workspace import select_project_persona_manager

    class Custom(Upstream):
        pass

    app = extension.PersonaManagerExtension(persona_manager_class=Custom)
    assert select_project_persona_manager(_server(app)) is False
    assert app.persona_manager_class is Custom


def test_nothing_happens_without_jupyter_ai():
    pytest.importorskip("jupyter_ai_persona_manager")
    from jupyterlab_lightcone.agent_workspace import select_project_persona_manager

    server = SimpleNamespace(extension_manager=SimpleNamespace(extension_apps={}))
    assert select_project_persona_manager(server) is False
