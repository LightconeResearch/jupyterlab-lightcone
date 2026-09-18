"""Project selection stays read-only; only explicit creation invokes the engine."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock

from lightcone.engine.project import ConvergenceReport, ProjectError
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import projects, project_routes


ENDPOINT = ("jupyterlab_lightcone", "api", "projects")


@pytest.fixture
def jp_base_url():
    return "/user/researcher/"


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
        (ConvergenceReport(blocked=[".venv", "git"]), ".venv; git"),
    ],
)
async def test_engine_refusals_reach_the_user_verbatim(tmp_path, monkeypatch, outcome, expected):
    monkeypatch.setattr(projects, "converge", Mock(side_effect=[outcome]))
    with pytest.raises(HTTPError) as error:
        await projects.initialize_project(tmp_path, tmp_path / "new")
    assert error.value.status_code == 400
    assert expected in str(error.value)


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
