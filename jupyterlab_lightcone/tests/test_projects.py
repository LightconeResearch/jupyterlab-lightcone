"""Project selection stays read-only; only explicit creation invokes the engine."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from lightcone.engine.project import ConvergenceReport, ProjectError
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import projects, project_routes


ENDPOINT = ("jupyterlab_lightcone", "api", "projects")


@pytest.fixture
def jp_base_url():
    return "/user/researcher/"


@pytest.fixture
def tree(tmp_path):
    """A project holding a chats folder and a nested project, beside a loose folder."""
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
def test_owning_project_is_the_nearest_ancestor_inside_the_root(tree, directory, expected):
    found = projects.owning_project(tree, Path(directory))
    assert found == (tree / expected if expected else None)


def test_a_specification_above_the_server_root_is_never_used(tree):
    assert projects.owning_project(tree / "project" / "chats", Path("deep")) is None


def test_a_non_file_specification_is_skipped_not_an_error(tree):
    (tree / "loose" / "astra.yaml").mkdir()
    assert projects.owning_project(tree, Path("loose")) is None


def test_a_project_symlinked_out_of_the_root_is_owned_as_the_browser_sees_it(tmp_path):
    """Contents serves the logical path, so the walk must not resolve it away."""
    home, scratch = tmp_path / "home", tmp_path / "scratch"
    (scratch / "proj" / "chats").mkdir(parents=True)
    (scratch / "proj" / "astra.yaml").write_text("name: linked\n")
    home.mkdir()
    (home / "proj").symlink_to(scratch / "proj")
    assert projects.owning_project(home, Path("proj/chats")) == home / "proj"
    assert projects.project_entrypoint(home, home / "proj") == "proj/astra.yaml"


def test_the_entrypoint_is_the_contents_path_of_the_specification(tmp_path):
    assert projects.project_entrypoint(tmp_path, tmp_path) == "astra.yaml"
    assert projects.project_entrypoint(tmp_path, tmp_path / "a" / "b") == "a/b/astra.yaml"


@pytest.mark.parametrize("entrypoint, expected", [
    ("astra.yaml", ""),
    ("./astra.yaml", ""),
    ("project/astra.yaml", "project"),
    ("team//project/./astra.yaml/", "team/project"),
])
def test_the_project_directory_is_the_contents_path_its_entrypoint_names(entrypoint, expected):
    """The one derivation the sessions, comments and agent routes share, inverse to `project_entrypoint`."""
    assert projects.project_directory(entrypoint) == expected


def test_resolves_new_and_existing_folders_without_writing(tmp_path):
    path = projects.project_path(tmp_path, "nested/my project")
    info = projects.describe_project(tmp_path, path)
    assert info["path"] == "nested/my project"
    assert info["hasSpec"] is False
    assert not path.exists()
    path.mkdir(parents=True)
    (path / "astra.yaml").write_text("name: example")
    assert projects.project_path(tmp_path, str(path)) == path
    assert projects.describe_project(tmp_path, path)["hasSpec"] is True


@pytest.mark.parametrize("value", ["../outside", "nested/../../outside", "/etc", "", " ", "a\x00b", "archive:example"])
def test_rejects_paths_outside_server(tmp_path, value):
    with pytest.raises(HTTPError):
        projects.project_path(tmp_path, value)


@pytest.mark.parametrize("entrypoint", [
    "", "/abs/astra.yaml", "a\\b/astra.yaml", "drive:astra.yaml", "a\x00b/astra.yaml", "../astra.yaml", "notes.yaml",
])
def test_an_entrypoint_the_server_cannot_serve_is_a_validation_error(tmp_path, entrypoint):
    with pytest.raises(HTTPError) as refused:
        projects.project_root(tmp_path, entrypoint)
    assert refused.value.status_code == 400


def test_rejects_symlink_escape_and_file_paths(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "escape").symlink_to(tmp_path)
    with pytest.raises(HTTPError):
        projects.project_path(root, "escape/project")
    (root / "file").write_text("keep me")
    with pytest.raises(HTTPError):
        projects.project_path(root, "file")
    (root / "astra.yaml").symlink_to(tmp_path / "outside.yaml")
    with pytest.raises(HTTPError):
        projects.project_path(root, ".")


async def test_delegates_to_the_engine_with_exact_selected_path(tmp_path, monkeypatch):
    target = tmp_path / "project with spaces"

    def converge(directory):
        assert directory == target
        target.mkdir()
        (target / "astra.yaml").write_text("name: test")
        return ConvergenceReport(created=["astra.yaml"])

    monkeypatch.setattr(projects, "converge", converge)
    info = await projects.initialize_project(tmp_path, target)
    assert info["path"] == "project with spaces"
    assert info["hasSpec"] is True


@pytest.mark.parametrize(
    "outcome,expected",
    [
        (ProjectError("uv is 50% installed"), "50% installed"),
        (
            ConvergenceReport(blocked=["data/", "git"], warnings=["data exists but is not a directory."]),
            "data/; git\ndata exists but is not a directory.",
        ),
    ],
)
async def test_engine_refusals_reach_the_user_verbatim(tmp_path, monkeypatch, outcome, expected):
    monkeypatch.setattr(projects, "converge", Mock(side_effect=[outcome]))
    with pytest.raises(HTTPError) as error:
        await projects.initialize_project(tmp_path, tmp_path / "new")
    assert error.value.status_code == 400
    assert expected in str(error.value)
    # jupyter_server replies with log_message as it stands, never formatted.
    assert not error.value.args


@pytest.mark.parametrize("entrypoint, expected", [
    ("project/astra.yaml", "project"),
    ("project/./astra.yaml", "project"),
    ("project/sub/astra.yaml", "project/sub"),
    ("loose/astra.yaml", None),
    ("project/chats/astra.yaml", None),
    ("project/other.yaml", None),
    ("../project/astra.yaml", None),
    ("/project/astra.yaml", None),
    ("drive:project/astra.yaml", None),
    ("project\\astra.yaml", None),
    ("", None),
    (None, None),
    (["project/astra.yaml"], None),
])
def test_a_reported_or_recorded_entrypoint_must_name_a_local_specification(tree, entrypoint, expected):
    found = projects.spec_project(tree, entrypoint)
    assert found == (tree / expected if expected else None)


def test_engine_tools_are_found_without_an_activated_environment(monkeypatch):
    scripts = projects.sysconfig.get_path("scripts")
    monkeypatch.setenv("PATH", "/usr/bin")
    projects.expose_engine_tools()
    projects.expose_engine_tools()
    assert projects.os.environ["PATH"] == f"/usr/bin{projects.os.pathsep}{scripts}"


async def test_inspection_creates_nothing(jp_fetch, jp_root_dir, monkeypatch):
    init = AsyncMock()
    monkeypatch.setattr(project_routes, "initialize_project", init)
    response = await jp_fetch(*ENDPOINT, params={"path": "new-project"})
    info = json.loads(response.body)
    assert info["hasSpec"] is False
    assert not (jp_root_dir / "new-project").exists()
    init.assert_not_called()


async def test_create_authorizes_and_uses_selected_directory(jp_fetch, jp_root_dir, monkeypatch):
    target = jp_root_dir / "new-project"
    init = AsyncMock(return_value=projects.describe_project(jp_root_dir, target))
    monkeypatch.setattr(project_routes, "initialize_project", init)
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "new-project"}))
    assert response.code == 200
    init.assert_awaited_once_with(jp_root_dir.resolve(), target.resolve())


@pytest.mark.parametrize("action,resource", [("read", "contents"), ("write", "contents"), ("execute", "lightcone")])
async def test_create_rejects_missing_permissions(jp_fetch, jp_serverapp, monkeypatch, action, resource):
    init = AsyncMock()
    monkeypatch.setattr(project_routes, "initialize_project", init)
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda handler, user, a, r: (a, r) != (action, resource))
    response = await jp_fetch(*ENDPOINT, method="POST", body='{"path":"example"}', raise_error=False)
    assert response.code == 403
    init.assert_not_called()


@pytest.mark.parametrize("path", ["../outside", ".private/new", "archive:example"])
async def test_route_rejects_inaccessible_paths(jp_fetch, path):
    response = await jp_fetch(*ENDPOINT, params={"path": path}, raise_error=False)
    assert response.code in (400, 403)


async def test_browse_marks_only_accessible_project_folders(jp_fetch, jp_root_dir, tmp_path):
    for name in ("project", "plain", ".hidden", "bad-spec", "escape-spec"):
        (jp_root_dir / name).mkdir()
    (jp_root_dir / "project" / "astra.yaml").write_text("name: example")
    (jp_root_dir / ".hidden" / "astra.yaml").write_text("name: private")
    (jp_root_dir / "bad-spec" / "astra.yaml").mkdir()
    (jp_root_dir / "escape-spec" / "astra.yaml").symlink_to(tmp_path / "outside.yaml")
    (jp_root_dir / "escape-folder").symlink_to(tmp_path)
    response = await jp_fetch(*ENDPOINT, params={"path": ".", "children": "true"})
    assert json.loads(response.body) == {"projects": ["project"]}


async def test_browse_requires_read_permission(jp_fetch, jp_serverapp, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args: False)
    response = await jp_fetch(*ENDPOINT, params={"children": "true"}, raise_error=False)
    assert response.code == 403


@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_unknown_home_is_a_validation_error(jp_fetch, method):
    path = "~lightcone_user_that_does_not_exist/project"
    kwargs = {"params": {"path": path}} if method == "GET" else {"body": json.dumps({"path": path})}
    response = await jp_fetch(*ENDPOINT, method=method, raise_error=False, **kwargs)
    assert response.code == 400


async def test_finish_existing_project_runs_initializer(jp_fetch, jp_root_dir, monkeypatch):
    target = jp_root_dir / "existing"
    target.mkdir()
    spec = target / "astra.yaml"
    spec.write_text("name: preserve me")
    init = AsyncMock(return_value=projects.describe_project(jp_root_dir, target))
    monkeypatch.setattr(project_routes, "initialize_project", init)
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "existing"}))
    assert response.code == 200
    init.assert_awaited_once_with(jp_root_dir.resolve(), target.resolve())
    assert spec.read_text() == "name: preserve me"


async def test_a_running_setup_blocks_only_its_own_folder(jp_fetch, jp_root_dir, monkeypatch):
    release = asyncio.Event()

    async def init(root, project):
        if project.name == "slow":
            await release.wait()
        return projects.describe_project(root, project)

    monkeypatch.setattr(project_routes, "initialize_project", init)

    def create(name, **kwargs):
        return jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": name}), **kwargs)

    slow = asyncio.ensure_future(create("slow"))
    await asyncio.sleep(0.1)
    assert (await create("slow", raise_error=False)).code == 409
    assert (await create("other")).code == 200
    release.set()
    assert (await slow).code == 200
    assert (await create("slow")).code == 200


async def test_sync_contents_calls_run_off_the_event_loop():
    import threading
    main_thread = threading.get_ident()
    assert await project_routes.contents_call(threading.get_ident) != main_thread

    async def async_method():
        return threading.get_ident()

    assert await project_routes.contents_call(async_method) == main_thread


CURRENT = ("jupyterlab_lightcone", "api", "current-project")


async def test_the_browser_reports_and_clears_the_current_project(jp_fetch, jp_root_dir, jp_serverapp):
    (jp_root_dir / "project").mkdir()
    (jp_root_dir / "project" / "astra.yaml").write_text("name: example")
    response = await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": "project/./astra.yaml"}))
    assert json.loads(response.body) == {"entrypoint": "project/astra.yaml"}
    assert jp_serverapp.web_app.settings[projects.CURRENT_PROJECT] == "project/astra.yaml"
    await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": None}))
    assert jp_serverapp.web_app.settings[projects.CURRENT_PROJECT] is None


@pytest.mark.parametrize("entrypoint, status", [
    ("missing/astra.yaml", 400),
    ("../outside/astra.yaml", 400),
    ("plain/notes.yaml", 400),
    (".hidden/astra.yaml", 404),
])
async def test_a_project_the_server_cannot_serve_leaves_nothing_current(jp_fetch, jp_root_dir, jp_serverapp, entrypoint, status):
    """The browser moved on; new chats must not join the project it left."""
    for name in ("project", "plain", ".hidden"):
        (jp_root_dir / name).mkdir()
    (jp_root_dir / "project" / "astra.yaml").write_text("name: example")
    (jp_root_dir / "plain" / "notes.yaml").write_text("name: example")
    (jp_root_dir / ".hidden" / "astra.yaml").write_text("name: private")
    await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": "project/astra.yaml"}))
    response = await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": entrypoint}), raise_error=False)
    assert response.code == status
    assert jp_serverapp.web_app.settings[projects.CURRENT_PROJECT] is None


@pytest.mark.parametrize("body", [{}, ["project/astra.yaml"], {"entrypoint": 1}])
async def test_a_malformed_report_changes_nothing(jp_fetch, jp_root_dir, jp_serverapp, body):
    (jp_root_dir / "astra.yaml").write_text("name: example")
    await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": "astra.yaml"}))
    response = await jp_fetch(*CURRENT, method="PUT", body=json.dumps(body), raise_error=False)
    assert response.code == 400
    assert jp_serverapp.web_app.settings[projects.CURRENT_PROJECT] == "astra.yaml"


async def test_changing_the_current_project_requires_write_permission(jp_fetch, jp_root_dir, jp_serverapp, monkeypatch):
    (jp_root_dir / "astra.yaml").write_text("name: example")
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda handler, user, action, resource: action != "write")
    response = await jp_fetch(*CURRENT, method="PUT", body=json.dumps({"entrypoint": "astra.yaml"}), raise_error=False)
    assert response.code == 403
    assert projects.CURRENT_PROJECT not in jp_serverapp.web_app.settings


@pytest.mark.parametrize("method,kwargs,status", [
    ("GET", {"params": {"path": "."}}, 200),
    ("GET", {"params": {"path": "../outside"}}, 400),
    ("POST", {"body": "{}"}, 400),
])
async def test_project_answers_and_errors_are_not_cached(jp_fetch, method, kwargs, status):
    """Setup and validation replies must be refreshed after the project changes."""
    response = await jp_fetch(*ENDPOINT, method=method, raise_error=False, **kwargs)
    assert response.code == status
    assert response.headers.get("Cache-Control") == "no-store"
