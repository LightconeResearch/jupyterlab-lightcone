"""Each project remembers the agent its messages last went to."""
import json
from pathlib import Path

import pytest
from tornado.httpclient import HTTPClientError

from jupyterlab_lightcone import agent_defaults
from jupyterlab_lightcone.agent_defaults import (
    AGENT_STORE,
    read_project_agent,
    remember_agent,
    write_project_agent,
)
from jupyterlab_lightcone.project_store import StoreError, store_path

ENDPOINT = ("jupyterlab_lightcone", "api", "project-agent")
CLAUDE = "jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona"
CODEX = "jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona"


class Log:
    def __init__(self):
        self.warnings = []

    def warning(self, message, *args, **kwargs):
        self.warnings.append(message % args)


def test_a_project_without_a_record_has_no_agent(tmp_path):
    assert read_project_agent(tmp_path) is None


@pytest.mark.parametrize("text", ["not json", "[]", '{"persona": 3}', '{"persona": ""}'])
def test_an_unreadable_record_counts_as_none(tmp_path, text):
    store = store_path(tmp_path, AGENT_STORE)
    store.parent.mkdir()
    store.write_text(text)
    assert read_project_agent(tmp_path) is None


def test_the_record_is_written_once_and_replaced_whole(tmp_path):
    store = store_path(tmp_path, AGENT_STORE)
    write_project_agent(tmp_path, CLAUDE)
    assert json.loads(store.read_text()) == {"persona": CLAUDE}
    written = store.stat().st_mtime_ns
    write_project_agent(tmp_path, CLAUDE)
    assert store.stat().st_mtime_ns == written
    write_project_agent(tmp_path, CODEX)
    assert read_project_agent(tmp_path) == CODEX
    # No temporary file is left behind.
    assert sorted(path.name for path in store.parent.iterdir()) == ["agent.json"]


def test_remembering_records_the_projects_agent_and_nothing_outside_a_project(tmp_path):
    log = Log()
    remember_agent(tmp_path, CLAUDE, log)
    assert read_project_agent(tmp_path) == CLAUDE
    remember_agent(None, CODEX, log)
    assert read_project_agent(tmp_path) == CLAUDE
    assert log.warnings == []


def test_a_project_that_cannot_be_written_is_logged_not_raised(tmp_path, monkeypatch):
    def refuse(project, persona_id):
        raise PermissionError("read-only")

    monkeypatch.setattr(agent_defaults, "write_project_agent", refuse)
    log = Log()
    remember_agent(tmp_path, CLAUDE, log)
    assert len(log.warnings) == 1


@pytest.mark.parametrize("linked_directory", [True, False])
def test_project_stores_do_not_read_or_replace_linked_files(tmp_path, linked_directory):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    write_project_agent(outside, CODEX)
    destination = outside / ".lightcone" / AGENT_STORE
    if linked_directory:
        (project / ".lightcone").symlink_to(destination.parent, target_is_directory=True)
    else:
        (project / ".lightcone").mkdir()
        (project / ".lightcone" / AGENT_STORE).symlink_to(destination)
    assert read_project_agent(project) is None
    with pytest.raises(StoreError) as refused:
        write_project_agent(project, CLAUDE)
    assert refused.value.status == 403
    log = Log()
    remember_agent(project, CLAUDE, log)
    assert len(log.warnings) == 1
    assert json.loads(destination.read_text()) == {"persona": CODEX}


def test_a_project_reached_through_a_symlink_keeps_its_own_store(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(project, target_is_directory=True)
    write_project_agent(linked, CLAUDE)
    assert read_project_agent(linked) == CLAUDE
    assert read_project_agent(project) == CLAUDE


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
