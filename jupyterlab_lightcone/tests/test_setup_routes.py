"""Setup diagnostics describe only what is really there and never fail on a missing tool."""

import json
import os
from pathlib import Path
import subprocess

from lightcone.engine.sandbox import Capability, Unavailable
import pytest

from jupyterlab_lightcone import setup_routes

ENDPOINT = ("jupyterlab_lightcone", "api", "setup")
REPORT_KEYS = {"jupyterAi", "agents", "skills", "tools", "sandbox", "environment", "instructions", "storage"}
TOOL_KEYS = {"uv", "git", "git-annex", "myst"}
SKILL_ROWS = {("claude", "lightcone"), ("claude", "astra"), ("codex", "lightcone"), ("codex", "astra")}
GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.org",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.org",
}


def assert_matches_contract(report):
    """Mirror the checks of `isSetupReport` in src/customize/setup-api.ts."""
    assert set(report) == REPORT_KEYS
    assert isinstance(report["jupyterAi"], bool)
    for agent in report["agents"]:
        assert isinstance(agent["id"], str) and isinstance(agent["name"], str)
        assert isinstance(agent["installed"], bool)
        executable = agent["executable"]
        assert isinstance(executable["name"], str) and isinstance(executable["found"], bool)
        assert executable["path"] is None or isinstance(executable["path"], str)
    for skill in report["skills"]:
        assert skill["harness"] in ("claude", "codex") and isinstance(skill["name"], str)
        assert skill["version"] is None or isinstance(skill["version"], str)
        assert isinstance(skill["path"], str) and isinstance(skill["found"], bool)
    assert set(report["tools"]) == TOOL_KEYS
    for tool in report["tools"].values():
        assert isinstance(tool["found"], bool)
        assert tool["path"] is None or isinstance(tool["path"], str)
        assert tool["version"] is None or isinstance(tool["version"], str)
    sandbox = report["sandbox"]
    assert sandbox["backend"] is None or isinstance(sandbox["backend"], str)
    assert isinstance(sandbox["available"], bool)
    environment = report["environment"]
    assert environment is None or (isinstance(environment["lock"], bool) and isinstance(environment["venv"], bool))
    instructions = report["instructions"]
    assert instructions is None or (isinstance(instructions["path"], str) and isinstance(instructions["exists"], bool))
    storage = report["storage"]
    assert storage is None or (
        isinstance(storage["annex"], bool) and all(isinstance(remote, str) for remote in storage["remotes"])
    )


# Tools


@pytest.mark.parametrize("banner, expected", [
    ("uv 0.12.5 (x86_64-unknown-linux-gnu)\n", "0.12.5"),
    ("git version 2.55.0\n", "2.55.0"),
    ("10.20260901-g29d2c4f5723a6bc5dc380b5fd75b4e60aad6e4e1\n", "10.20260901"),
    ("v1.10.1\n", "1.10.1"),
    ("no version here", None),
    ("", None),
    (None, None),
])
def test_parse_version_reads_the_dotted_number(banner, expected):
    assert setup_routes.parse_version(banner) == expected


def test_a_missing_tool_is_reported_not_raised(monkeypatch):
    monkeypatch.setattr(setup_routes.shutil, "which", lambda name: None)
    assert setup_routes.probe_tool("uv", "--version") == {"found": False, "path": None, "version": None}


@pytest.mark.parametrize("failure", [subprocess.TimeoutExpired(["tool"], 1), OSError("cannot start")])
def test_a_hung_or_broken_probe_still_reports_the_path(monkeypatch, failure):
    monkeypatch.setattr(setup_routes.shutil, "which", lambda name: "/opt/bin/tool")

    def run(*args, **kwargs):
        raise failure

    monkeypatch.setattr(setup_routes.subprocess, "run", run)
    assert setup_routes.probe_tool("tool", "--version") == {"found": True, "path": "/opt/bin/tool", "version": None}


def test_a_failing_version_command_reports_no_version(monkeypatch):
    monkeypatch.setattr(setup_routes.shutil, "which", lambda name: "/opt/bin/tool")
    monkeypatch.setattr(
        setup_routes.subprocess, "run", lambda argv, **kwargs: subprocess.CompletedProcess(argv, 1, "1.2.3\n", "")
    )
    assert setup_routes.probe_tool("tool", "--version")["version"] is None


def test_a_version_printed_on_stderr_is_read_too(monkeypatch):
    monkeypatch.setattr(setup_routes.shutil, "which", lambda name: "/opt/bin/tool")
    monkeypatch.setattr(
        setup_routes.subprocess, "run", lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "tool 4.5\n")
    )
    assert setup_routes.probe_tool("tool", "--version")["version"] == "4.5"


def test_git_is_probed_for_real():
    tool = setup_routes.probe_tool("git", "--version")
    assert tool["found"] is True
    assert tool["path"].endswith("git")
    assert setup_routes.parse_version(tool["version"]) == tool["version"]


def test_the_myst_row_uses_the_configured_executable(monkeypatch):
    asked = []
    monkeypatch.setattr(setup_routes.shutil, "which", lambda name: asked.append(name))
    tools = setup_routes.probe_tools("/opt/myst/bin/myst")
    assert set(tools) == TOOL_KEYS
    assert asked == ["uv", "git", "git-annex", "/opt/myst/bin/myst"]


# Agents


def test_module_presence_is_checked_without_importing():
    assert setup_routes.module_installed("json") is True
    assert setup_routes.module_installed("jupyterlab_lightcone_no_such_module") is False
    assert setup_routes.module_installed("no_such_parent.child") is False
    assert setup_routes.module_installed("") is False


def test_agents_pair_the_client_with_each_adapter(monkeypatch):
    monkeypatch.setattr(setup_routes, "module_installed", lambda name: name == setup_routes.ACP_CLIENT_MODULE)
    monkeypatch.setattr(
        setup_routes.shutil, "which", lambda name: "/opt/bin/claude-agent-acp" if name == "claude-agent-acp" else None
    )
    assert setup_routes.probe_agents() == [
        {
            "id": "claude-acp",
            "name": "Claude",
            "installed": True,
            "executable": {"name": "claude-agent-acp", "found": True, "path": "/opt/bin/claude-agent-acp"},
        },
        {
            "id": "codex-acp",
            "name": "Codex",
            "installed": True,
            "executable": {"name": "codex-acp", "found": False, "path": None},
        },
    ]


# Skills


def plugin(root, *parts, name=None, version=None, manifest=".claude-plugin/plugin.json"):
    """Create a plugin directory holding a manifest and return it."""
    directory = root.joinpath(*parts)
    path = directory / manifest
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if name is not None:
        data["name"] = name
    if version is not None:
        data["version"] = version
    path.write_text(json.dumps(data))
    return directory


def rows(skills):
    return {(skill["harness"], skill["name"]): skill for skill in skills}


@pytest.fixture
def home(tmp_path):
    """A home laid out like Claude Code's and Codex's plugin caches: `cache/<marketplace>/<plugin>/<version>`."""
    claude = tmp_path / ".claude" / "plugins"
    codex = tmp_path / ".codex" / "plugins"
    plugin(claude, "cache", "lightcone-research", "lightcone", "0.0.1", name="lightcone", version="0.0.1")
    plugin(claude, "cache", "lightcone-research", "lightcone", "0.0.2", name="lightcone", version="0.0.2")
    plugin(claude, "cache", "lightcone-research", "astra", "0.0.3", name="astra", version="0.0.3")
    (claude / "data" / "lightcone-lightcone-research").mkdir(parents=True)
    plugin(
        codex, "cache", "lightcone-research", "lightcone", "0.0.2",
        name="lightcone", version="0.0.2", manifest=".codex-plugin/plugin.json",
    )
    return tmp_path


def test_skills_are_the_newest_cached_version_per_harness(home):
    found = rows(setup_routes.find_skills(home))
    claude = home / ".claude" / "plugins"
    codex = home / ".codex" / "plugins"
    assert set(found) == SKILL_ROWS
    assert found[("claude", "lightcone")] == {
        "harness": "claude",
        "name": "lightcone",
        "version": "0.0.2",
        "path": str(claude / "cache" / "lightcone-research" / "lightcone" / "0.0.2"),
        "found": True,
    }
    assert found[("claude", "astra")]["version"] == "0.0.3"
    assert found[("codex", "lightcone")] == {
        "harness": "codex",
        "name": "lightcone",
        "version": "0.0.2",
        "path": str(codex / "cache" / "lightcone-research" / "lightcone" / "0.0.2"),
        "found": True,
    }
    assert found[("codex", "astra")] == {
        "harness": "codex", "name": "astra", "version": None, "path": str(codex), "found": False,
    }


def test_claude_reports_the_version_its_install_record_names(home):
    claude = home / ".claude" / "plugins"
    installed = claude / "cache" / "lightcone-research" / "lightcone" / "0.0.1"
    record = {
        "version": 2,
        "plugins": {
            "lightcone@lightcone-research": [{"installPath": str(installed), "version": "0.0.1"}],
            "astra@lightcone-research": [{"installPath": str(claude / "gone"), "version": "9.9.9"}],
        },
    }
    (claude / "installed_plugins.json").write_text(json.dumps(record))
    found = rows(setup_routes.find_skills(home))
    assert found[("claude", "lightcone")]["version"] == "0.0.1"
    assert found[("claude", "lightcone")]["path"] == str(installed)
    # A recorded path that no longer exists falls back to the cache walk.
    assert found[("claude", "astra")]["version"] == "0.0.3"
    # Codex keeps no install record; its cache decides.
    assert found[("codex", "lightcone")]["version"] == "0.0.2"


def test_an_install_record_without_a_manifest_keeps_its_own_version(tmp_path):
    claude = tmp_path / ".claude" / "plugins"
    installed = claude / "cache" / "market" / "lightcone" / "abc123"
    installed.mkdir(parents=True)
    record = {"plugins": {"lightcone@market": [{"installPath": str(installed), "version": "abc123"}]}}
    (claude / "installed_plugins.json").write_text(json.dumps(record))
    found = rows(setup_routes.find_skills(tmp_path))
    assert found[("claude", "lightcone")] == {
        "harness": "claude", "name": "lightcone", "version": "abc123", "path": str(installed), "found": True,
    }


def test_folders_that_merely_share_the_prefix_are_not_skills(tmp_path):
    claude = tmp_path / ".claude" / "plugins"
    # A marketplace folder named after the publisher holds no manifest of its own.
    (claude / "cache" / "lightcone-research").mkdir(parents=True)
    # A manifest naming another plugin does not count either.
    plugin(claude, "cache", "other", "lightcone-tools", name="other-tool", version="1.0")
    found = rows(setup_routes.find_skills(tmp_path))
    assert found[("claude", "lightcone")] == {
        "harness": "claude", "name": "lightcone", "version": None, "path": str(claude), "found": False,
    }


def test_a_manifest_without_a_name_or_version_still_counts(tmp_path):
    directory = plugin(tmp_path / ".codex" / "plugins", "lightcone", manifest="plugin.json")
    found = rows(setup_routes.find_skills(tmp_path))
    assert found[("codex", "lightcone")] == {
        "harness": "codex", "name": "lightcone", "version": None, "path": str(directory), "found": True,
    }


def test_the_search_stops_at_the_depth_bound(tmp_path):
    claude = tmp_path / ".claude" / "plugins"
    plugin(claude, "a", "b", "c", "lightcone", name="lightcone", version="1.0")
    plugin(claude, "a", "b", "c", "d", "astra", name="astra", version="1.0")
    found = rows(setup_routes.find_skills(tmp_path))
    assert found[("claude", "lightcone")]["found"] is True
    assert found[("claude", "astra")]["found"] is False


def test_broken_or_oversized_manifests_are_ignored(tmp_path, monkeypatch):
    claude = tmp_path / ".claude" / "plugins"
    directory = plugin(claude, "lightcone", name="lightcone", version="1.0")
    assert rows(setup_routes.find_skills(tmp_path))[("claude", "lightcone")]["found"] is True
    monkeypatch.setattr(setup_routes, "MAX_MANIFEST_BYTES", 8)
    assert rows(setup_routes.find_skills(tmp_path))[("claude", "lightcone")]["found"] is False
    monkeypatch.undo()
    (directory / ".claude-plugin" / "plugin.json").write_text("{not json")
    assert rows(setup_routes.find_skills(tmp_path))[("claude", "lightcone")]["found"] is False


def test_versions_order_numerically():
    assert setup_routes.version_key("0.0.10") > setup_routes.version_key("0.0.9")
    assert setup_routes.version_key("1.10") > setup_routes.version_key("1.2")
    assert setup_routes.version_key("10.20260901-g29d2") > setup_routes.version_key("10.20250101")


def test_without_a_home_every_skill_is_missing():
    skills = setup_routes.find_skills(None)
    assert {(skill["harness"], skill["name"]) for skill in skills} == SKILL_ROWS
    assert all(skill["found"] is False for skill in skills)


# Sandbox


@pytest.mark.parametrize("kind, expected", [
    ("landlock", {"backend": "landlock", "available": True}),
    ("seatbelt", {"backend": "seatbelt", "available": True}),
    ("none", {"backend": None, "available": False}),
])
def test_sandbox_reports_the_detected_backend(monkeypatch, kind, expected):
    monkeypatch.setattr(setup_routes, "detect_backend", lambda: Unavailable(capability=Capability(kind=kind)))
    assert setup_routes.detect_sandbox() == expected


def test_a_failing_sandbox_probe_means_no_boundary(monkeypatch):
    def detect():
        raise RuntimeError("no kernel support")

    monkeypatch.setattr(setup_routes, "detect_backend", detect)
    assert setup_routes.detect_sandbox() == {"backend": None, "available": False}


def test_the_real_sandbox_probe_matches_the_contract():
    sandbox = setup_routes.detect_sandbox()
    assert sandbox["available"] == (sandbox["backend"] is not None)


# Project


@pytest.mark.parametrize("entrypoint, directory", [
    ("astra.yaml", ""),
    ("project/astra.yaml", "project"),
    ("a/b/./astra.yaml", "a/b"),
])
def test_project_directory_is_the_contents_path_of_the_folder(entrypoint, directory):
    assert setup_routes.project_directory(entrypoint) == directory


def test_instructions_prefer_agents_md_then_claude_md(tmp_path):
    assert setup_routes.describe_instructions(tmp_path, "proj") == {"path": "proj/AGENTS.md", "exists": False}
    (tmp_path / "CLAUDE.md").write_text("# rules\n")
    assert setup_routes.describe_instructions(tmp_path, "") == {"path": "CLAUDE.md", "exists": True}
    (tmp_path / "AGENTS.md").write_text("# rules\n")
    assert setup_routes.describe_instructions(tmp_path, "proj") == {"path": "proj/AGENTS.md", "exists": True}


def test_environment_reports_lock_and_venv(tmp_path):
    assert setup_routes.describe_environment(tmp_path) == {"lock": False, "venv": False}
    (tmp_path / "uv.lock").write_text("")
    (tmp_path / ".venv").mkdir()
    assert setup_routes.describe_environment(tmp_path) == {"lock": True, "venv": True}


# Storage


def git(*args, cwd):
    subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env={**os.environ, **GIT_IDENTITY}
    )


@pytest.fixture
def annex(tmp_path):
    """A git-annex repository cloned from another, so it knows one remote."""
    origin = tmp_path / "origin"
    origin.mkdir()
    git("init", "-q", cwd=origin)
    git("annex", "init", "origin-repo", cwd=origin)
    (origin / "README").write_text("data\n")
    git("add", "README", cwd=origin)
    git("commit", "-qm", "init", cwd=origin)
    work = tmp_path / "work"
    git("clone", "-q", str(origin), str(work), cwd=tmp_path)
    git("annex", "init", "work-repo", cwd=work)
    git("fetch", "-q", "origin", cwd=work)
    return work


def test_storage_reads_a_real_annex_repository(annex):
    assert setup_routes.describe_storage(annex) == {"annex": True, "remotes": ["origin"]}


def test_a_plain_repository_or_folder_is_not_an_annex(tmp_path):
    git("init", "-q", cwd=tmp_path)
    assert setup_routes.describe_storage(tmp_path) == {"annex": False, "remotes": []}
    assert setup_routes.describe_storage(tmp_path / "missing") == {"annex": False, "remotes": []}


def test_storage_degrades_when_git_annex_hangs(tmp_path, monkeypatch):
    def run(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))

    monkeypatch.setattr(setup_routes.subprocess, "run", run)
    assert setup_routes.describe_storage(tmp_path) == {"annex": False, "remotes": []}


@pytest.mark.parametrize("output", ["not json", json.dumps([]), json.dumps({"success": False})])
def test_unexpected_annex_output_is_not_an_annex(tmp_path, monkeypatch, output):
    monkeypatch.setattr(
        setup_routes.subprocess, "run", lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, output, "")
    )
    assert setup_routes.describe_storage(tmp_path) == {"annex": False, "remotes": []}


@pytest.mark.parametrize("description, expected", [
    ("origin-repo [origin]", "origin"),
    ("elsewhere", "elsewhere"),
    ("name [with] [remote]", "remote"),
])
def test_remote_names_come_from_annex_descriptions(description, expected):
    assert setup_routes.remote_name(description) == expected


def test_storage_ignores_special_remotes_and_this_repository(tmp_path, monkeypatch):
    info = {
        "success": True,
        "trusted repositories": [{"description": "archive", "here": False, "uuid": "3"}],
        "semitrusted repositories": [
            {"description": "web", "here": False, "uuid": "00000000-0000-0000-0000-000000000001"},
            {"description": "bittorrent", "here": False, "uuid": "00000000-0000-0000-0000-000000000002"},
            {"description": "me", "here": True, "uuid": "1"},
            {"description": "backup [nas]", "here": False, "uuid": "2"},
            "not a repository",
        ],
        "untrusted repositories": "not a list",
    }
    monkeypatch.setattr(
        setup_routes.subprocess,
        "run",
        lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, json.dumps(info), ""),
    )
    assert setup_routes.describe_storage(tmp_path) == {"annex": True, "remotes": ["archive", "nas"]}


# The report


async def test_the_report_without_a_project_has_null_project_sections(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    report = await setup_routes.build_report(None)
    assert_matches_contract(report)
    assert (report["environment"], report["instructions"], report["storage"]) == (None, None, None)
    assert [agent["id"] for agent in report["agents"]] == ["claude-acp", "codex-acp"]
    assert {(skill["harness"], skill["name"]) for skill in report["skills"]} == SKILL_ROWS
    assert report["tools"]["git"]["found"] is True


async def test_the_report_describes_the_project(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    project = tmp_path / "root" / "project"
    (project / ".venv").mkdir(parents=True)
    (project / "uv.lock").write_text("")
    (project / "AGENTS.md").write_text("# rules\n")
    report = await setup_routes.build_report(project, "project/astra.yaml")
    assert_matches_contract(report)
    assert report["environment"] == {"lock": True, "venv": True}
    assert report["instructions"] == {"path": "project/AGENTS.md", "exists": True}
    assert report["storage"] == {"annex": False, "remotes": []}


# The route


@pytest.fixture
def api(jp_serverapp, jp_fetch):
    """The route, registered on the test server the way the application registers it."""
    setup_routes.setup_setup_handlers(jp_serverapp.web_app, ["myst"])

    def fetch(**kwargs):
        return jp_fetch(*ENDPOINT, **kwargs)

    return fetch


async def test_the_route_describes_the_server_without_a_project(api):
    response = await api()
    assert response.code == 200
    assert response.headers["Cache-Control"] == "no-store"
    report = json.loads(response.body)
    assert_matches_contract(report)
    assert (report["environment"], report["instructions"], report["storage"]) == (None, None, None)


async def test_the_route_describes_the_named_project(api, jp_root_dir):
    project = jp_root_dir / "project"
    (project / ".venv").mkdir(parents=True)
    (project / "astra.yaml").write_text("name: example\n")
    (project / "uv.lock").write_text("")
    (project / "CLAUDE.md").write_text("# rules\n")
    report = json.loads((await api(params={"path": "project/astra.yaml"})).body)
    assert_matches_contract(report)
    assert report["environment"] == {"lock": True, "venv": True}
    assert report["instructions"] == {"path": "project/CLAUDE.md", "exists": True}
    assert report["storage"] == {"annex": False, "remotes": []}


async def test_a_root_project_without_instructions_points_at_agents_md(api, jp_root_dir):
    (jp_root_dir / "astra.yaml").write_text("name: example\n")
    report = json.loads((await api(params={"path": "astra.yaml"})).body)
    assert report["environment"] == {"lock": False, "venv": False}
    assert report["instructions"] == {"path": "AGENTS.md", "exists": False}


async def test_an_empty_path_means_no_project(api):
    report = json.loads((await api(params={"path": ""})).body)
    assert report["environment"] is None


@pytest.mark.parametrize("path, status", [
    ("../outside/astra.yaml", 400),
    ("project/notes.yaml", 400),
    ("missing/astra.yaml", 404),
    (".hidden/astra.yaml", 404),
])
async def test_a_project_the_server_cannot_serve_is_refused(api, jp_root_dir, path, status):
    (jp_root_dir / ".hidden").mkdir()
    (jp_root_dir / ".hidden" / "astra.yaml").write_text("name: private\n")
    response = await api(params={"path": path}, raise_error=False)
    assert response.code == status


class TestConfiguredMySTCommand:
    """The extension registers the route with the MyST executable it is configured with."""

    @pytest.fixture
    def jp_server_config(self, jp_server_config):
        return {
            **jp_server_config,
            "LightconeApp": {"mystra_command": ["/opt/myst/bin/myst", "--fixed-argument"]},
        }

    async def test_the_configured_myst_command_reaches_the_probe(self, jp_serverapp, jp_fetch, monkeypatch):
        asked = []

        def probe_tools(myst):
            asked.append(myst)
            missing = {"found": False, "path": None, "version": None}
            return {"uv": missing, "git": missing, "git-annex": missing, "myst": missing}

        monkeypatch.setattr(setup_routes, "probe_tools", probe_tools)
        response = await jp_fetch(*ENDPOINT)
        assert response.code == 200
        assert asked == ["/opt/myst/bin/myst"]


async def test_probe_failures_never_fail_the_request(api, monkeypatch):
    monkeypatch.setattr(setup_routes, "run_command", lambda *args, **kwargs: None)

    def detect():
        raise RuntimeError("no kernel support")

    monkeypatch.setattr(setup_routes, "detect_backend", detect)
    response = await api()
    assert response.code == 200
    report = json.loads(response.body)
    assert_matches_contract(report)
    assert all(tool["version"] is None for tool in report["tools"].values())
    assert report["sandbox"] == {"backend": None, "available": False}


async def test_requires_authentication(api):
    response = await api(follow_redirects=False, headers={"Authorization": ""}, raise_error=False)
    assert response.code in (302, 403)


async def test_requires_contents_read_authorization(api, jp_serverapp, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args, **kwargs: False)
    response = await api(raise_error=False)
    assert response.code == 403
