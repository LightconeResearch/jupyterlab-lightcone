"""Agent discovery must not create a chat or engage an agent."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from jupyter_ai_persona_manager import BasePersona, PersonaDefaults, PersonaManager
from traitlets.config import Config, LoggingConfigurable

from jupyterlab_lightcone.agent_defaults import write_project_agent
from jupyterlab_lightcone.project_agents import available_agents


class FirstPersona(BasePersona):
    @property
    def defaults(self):
        return PersonaDefaults(name="First", description="Test", avatar_path="", system_prompt="")

    async def prepare(self):
        raise AssertionError("Discovery must not prepare an agent")

    async def process_message(self, message):
        raise AssertionError("Discovery must not send messages")

    async def shutdown(self):
        raise AssertionError("Discovery must not stop shared agent processes")


class SecondPersona(FirstPersona):
    @property
    def defaults(self):
        return PersonaDefaults(name="Second", description="Test", avatar_path="", system_prompt="")


@pytest.fixture
def discovery(tmp_path, monkeypatch):
    extension = LoggingConfigurable(config=Config({"PersonaManager": {"default_persona_id": "removed"}}))
    extension.persona_manager_class = PersonaManager
    extension.serverapp = SimpleNamespace(web_app=SimpleNamespace(settings={}))
    monkeypatch.setattr(PersonaManager, "_ep_persona_classes", [{"persona_class": FirstPersona}])
    project = tmp_path / "project"
    project.mkdir()
    (project / "astra.yaml").write_text("name: test\n")
    return extension, tmp_path, project


async def test_lists_agents_without_a_chat_or_agent_lifecycle(discovery):
    result = await available_agents(*discovery)
    assert [item["name"] for item in result["personas"]] == ["First"]
    assert result["default"] == result["personas"][0]["id"]
    assert sorted(path.name for path in discovery[2].iterdir()) == ["astra.yaml"]


async def test_suggests_only_an_available_agent(discovery, monkeypatch):
    monkeypatch.setattr(PersonaManager, "_ep_persona_classes", [
        {"persona_class": FirstPersona}, {"persona_class": SecondPersona}
    ])
    result = await available_agents(*discovery)
    assert result["default"] is None
    second = result["personas"][1]["id"]
    write_project_agent(discovery[2], second)
    assert (await available_agents(*discovery))["default"] == second


async def test_route_lists_agents_before_a_chat_exists(jp_fetch, jp_serverapp, discovery, monkeypatch):
    extension, _, _ = discovery
    apps = {**jp_serverapp.extension_manager.extension_apps, "jupyter_ai_persona_manager": [extension]}
    monkeypatch.setattr(type(jp_serverapp.extension_manager), "extension_apps", property(lambda self: apps))
    root = Path(jp_serverapp.contents_manager.root_dir)
    (root / "agent-project").mkdir()
    (root / "agent-project" / "astra.yaml").write_text("name: test\n")
    response = await jp_fetch("jupyterlab_lightcone", "api", "project-agents", params={"path": "agent-project/astra.yaml"})
    result = json.loads(response.body)
    assert [item["name"] for item in result["personas"]] == ["First"]
    assert response.headers["Cache-Control"] == "no-store"
