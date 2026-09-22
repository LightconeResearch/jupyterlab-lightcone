"""The tour's agent check reports adapters on PATH and installs nothing."""

import json

import pytest

from jupyterlab_lightcone import agents

ENDPOINT = ("jupyterlab_lightcone", "api", "agents")


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return "/user/researcher/"


def test_reports_each_adapter_and_npm_separately():
    found = {"claude-agent-acp": "/usr/bin/claude-agent-acp", "npm": "/usr/bin/npm"}
    report = agents.agent_readiness(which=found.get, personas={"claude-acp", "codex-acp"})
    assert report["npm"] is True
    by_id = {agent["id"]: agent for agent in report["agents"]}
    assert [agent["name"] for agent in report["agents"]] == ["Claude Code", "Codex", "OpenCode"]
    assert by_id["claude"]["installed"] and by_id["claude"]["offered"]
    assert not by_id["codex"]["installed"] and by_id["codex"]["offered"]
    assert not by_id["opencode"]["installed"] and not by_id["opencode"]["offered"]
    assert by_id["codex"]["install"] == "npm install -g @agentclientprotocol/codex-acp"
    assert by_id["opencode"]["login"] == "opencode auth login"


def test_personas_come_from_jupyter_ai_entry_points():
    # jupyter-ai is a dependency, so its ACP personas are registered in this environment.
    report = agents.agent_readiness(which=lambda name: None)
    assert all(agent["offered"] for agent in report["agents"])
    assert not any(agent["installed"] for agent in report["agents"])


async def test_route_looks_up_adapters_now_and_never_caches(jp_fetch, monkeypatch):
    monkeypatch.setattr(
        agents.shutil, "which", lambda name: "/opt/bin/codex-acp" if name == "codex-acp" else None
    )
    response = await jp_fetch(*ENDPOINT)
    assert response.headers["Cache-Control"] == "no-store"
    body = json.loads(response.body)
    assert body["npm"] is False
    assert {agent["id"]: agent["installed"] for agent in body["agents"]} == {
        "claude": False,
        "codex": True,
        "opencode": False,
    }


async def test_route_requires_read_permission(jp_fetch, jp_serverapp, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args: False)
    response = await jp_fetch(*ENDPOINT, raise_error=False)
    assert response.code == 403
