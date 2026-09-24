"""Each project remembers the agent its messages last went to."""
import json
from pathlib import Path

import pytest
from tornado.httpclient import HTTPClientError

from jupyterlab_lightcone import agent_defaults
from jupyterlab_lightcone.agent_defaults import (
    AGENT_FILE,
    DEFAULT_PERSONA_OPTION,
    read_project_agent,
    remember_agent,
    write_project_agent,
)

ENDPOINT = ("jupyterlab_lightcone", "api", "project-agent")
CLAUDE = "jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona"
CODEX = "jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona"


class Log:
    def __init__(self):
        self.warnings = []

    def warning(self, message, *args, **kwargs):
        self.warnings.append(message % args)


class WebApp:
    def __init__(self):
        self.settings = {}


def test_a_project_without_a_record_has_no_agent(tmp_path):
    assert read_project_agent(tmp_path) is None


@pytest.mark.parametrize("text", ["not json", "[]", '{"persona": 3}', '{"persona": ""}'])
def test_an_unreadable_record_counts_as_none(tmp_path, text):
    (tmp_path / ".lightcone").mkdir()
    (tmp_path / AGENT_FILE).write_text(text)
    assert read_project_agent(tmp_path) is None


def test_the_record_is_written_once_and_replaced_whole(tmp_path):
    write_project_agent(tmp_path, CLAUDE)
    assert json.loads((tmp_path / AGENT_FILE).read_text()) == {"persona": CLAUDE}
    written = (tmp_path / AGENT_FILE).stat().st_mtime_ns
    write_project_agent(tmp_path, CLAUDE)
    assert (tmp_path / AGENT_FILE).stat().st_mtime_ns == written
    write_project_agent(tmp_path, CODEX)
    assert read_project_agent(tmp_path) == CODEX
    # No temporary file is left behind.
    assert sorted(path.name for path in (tmp_path / ".lightcone").iterdir()) == ["agent.json"]


def test_remembering_sets_the_page_default_and_the_projects_record(tmp_path):
    web_app, log = WebApp(), Log()
    remember_agent(web_app, tmp_path, CLAUDE, log)
    assert web_app.settings["page_config_data"][DEFAULT_PERSONA_OPTION] == CLAUDE
    assert read_project_agent(tmp_path) == CLAUDE
    # A chat outside every project still moves the page default.
    remember_agent(web_app, None, CODEX, log)
    assert web_app.settings["page_config_data"][DEFAULT_PERSONA_OPTION] == CODEX
    assert read_project_agent(tmp_path) == CLAUDE
    assert log.warnings == []


def test_a_project_that_cannot_be_written_still_moves_the_page_default(tmp_path, monkeypatch):
    def refuse(project, persona_id):
        raise PermissionError("read-only")

    monkeypatch.setattr(agent_defaults, "write_project_agent", refuse)
    web_app, log = WebApp(), Log()
    remember_agent(web_app, tmp_path, CLAUDE, log)
    assert web_app.settings["page_config_data"][DEFAULT_PERSONA_OPTION] == CLAUDE
    assert len(log.warnings) == 1


# --- route ------------------------------------------------------------------


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return "/user/researcher/"


@pytest.fixture
def served(jp_serverapp):
    root = Path(jp_serverapp.contents_manager.root_dir)
    (root / "project").mkdir()
    (root / "project" / "astra.yaml").write_text("name: test\n")
    return root / "project"


async def test_the_route_reports_the_projects_agent(jp_fetch, served):
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert json.loads(response.body) == {"persona": None}
    assert response.headers["Cache-Control"] == "no-store"
    write_project_agent(served, CLAUDE)
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert json.loads(response.body) == {"persona": CLAUDE}


async def test_the_route_needs_a_project_inside_the_root(jp_fetch, served):
    with pytest.raises(HTTPClientError) as missing:
        await jp_fetch(*ENDPOINT, params={"path": "nowhere/astra.yaml"})
    assert missing.value.code == 404
    with pytest.raises(HTTPClientError) as outside:
        await jp_fetch(*ENDPOINT, params={"path": "../astra.yaml"})
    assert outside.value.code in (400, 403, 404)
