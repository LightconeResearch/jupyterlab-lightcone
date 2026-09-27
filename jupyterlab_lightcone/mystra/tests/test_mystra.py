"""Viewer path boundaries, real process cleanup, and authenticated API behavior."""

import asyncio
import gzip
import importlib.metadata
import json
import logging
import shutil
import sys
from pathlib import Path
from unittest.mock import AsyncMock

from jupyter_server.base.websocket import WebSocketMixin
import pytest
from tornado import web
from tornado.web import HTTPError

from .. import manager as mystra
from ..manager import MySTRAManager
from ..routes import MySTRASocketHandler


class Capabilities(web.RequestHandler):
    """A theme answering the viewer capability contract for whatever prefix it is asked under."""

    def get(self, path):
        self.finish(
            {
                "protocol": "mystra-viewer.v1",
                "baseUrl": self.request.path.rsplit("/site", 1)[0] + "/site",
            }
        )


@pytest.fixture
def manager(tmp_path):
    (tmp_path / "myst.yml").write_text("version: 1\n")
    manager = MySTRAManager(tmp_path, "/user/researcher/", logging.getLogger())
    manager.command = ["no-such-myst-executable"]
    return manager


def test_the_default_cli_is_mystmds_declared_entry_point():
    """The dependency's `myst` runs with this interpreter, whatever PATH holds.

    The command calls the console script mystmd declares, so a release that
    moves it fails here rather than at every viewer launch.
    """
    (myst,) = importlib.metadata.entry_points(group="console_scripts", name="myst")
    assert myst.dist.name == "mystmd"
    assert myst.value == "mystmd_py.main:main"
    assert MySTRAManager.command[:3] == (sys.executable, "-P", "-c")
    assert "from mystmd_py.main import main" in MySTRAManager.command[3]


@pytest.mark.parametrize("configured", [None, ""])
async def test_the_cli_cannot_prompt_to_install_nodejs(manager, tmp_path, monkeypatch, configured):
    """Without Node.js, mystmd asks on stdin; the server's terminal must never be asked.

    mystmd treats an empty MYSTMD_ALLOW_NODEENV as unset, so it is declined too.
    """
    if configured is None:
        monkeypatch.delenv("MYSTMD_ALLOW_NODEENV", raising=False)
    else:
        monkeypatch.setenv("MYSTMD_ALLOW_NODEENV", configured)
    cli = tmp_path / "prompting_cli.py"
    cli.write_text(
        "import os, sys, time\n"
        "print('nodeenv:', os.environ.get('MYSTMD_ALLOW_NODEENV'), flush=True)\n"
        "print('stdin:', repr(sys.stdin.read()), flush=True)\n"
        "time.sleep(120)\n"
    )
    manager.command = [sys.executable, str(cli)]
    session = await manager.start("alice", *manager.project_root(""))
    try:
        for _ in range(500):
            if len(session.logs) == 2:
                break
            await asyncio.sleep(0.01)
        assert list(session.logs) == ["nodeenv: no", "stdin: ''"]
    finally:
        await manager.close()


def test_discovers_nearest_config_and_yaml(manager, tmp_path):
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "myst.yaml").write_text("version: 1\n")
    (nested / "page.md").touch()
    assert manager.project_root("nested/page.md") == (nested, "nested/myst.yaml")
    assert manager.project_root("") == (tmp_path, "myst.yml")


def test_accepts_dotfiles_inside_a_project(manager, tmp_path):
    (tmp_path / ".gitignore").touch()
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "ci.yml").touch()
    assert manager.project_root(".gitignore") == (tmp_path, "myst.yml")
    assert manager.project_root(".github/workflows/ci.yml") == (tmp_path, "myst.yml")


@pytest.mark.parametrize(
    "path", ["../outside", "/tmp", "nested/../page", "./page", "a\\b", None]
)
def test_rejects_unsafe_paths(manager, path):
    with pytest.raises(HTTPError) as error:
        manager.project_root(path)
    assert error.value.status_code == 400


def test_rejects_symlink_escape(manager, tmp_path):
    (tmp_path / "escape").symlink_to(tmp_path.parent, target_is_directory=True)
    with pytest.raises(HTTPError) as error:
        manager.project_root("escape")
    assert error.value.status_code == 403


def test_rejects_a_configuration_symlinked_out_of_the_root(manager, tmp_path):
    outside = tmp_path.parent / f"{tmp_path.name}-outside.yml"
    outside.write_text("version: 1\n")
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "myst.yml").symlink_to(outside)
    with pytest.raises(HTTPError) as error:
        manager.project_root("nested")
    assert error.value.status_code == 403


async def test_concurrent_open_reuses_process_and_reports_missing_cli(manager):
    try:
        a, b = await asyncio.gather(
            manager.start("alice", *manager.project_root("")),
            manager.start("alice", *manager.project_root("myst.yml")),
        )
        assert a is b
        await a.task
        assert a.state == "failed"
        assert "MyST CLI is unavailable" in a.message
        with pytest.raises(HTTPError) as error:
            manager.get(a.id, "bob")
        assert error.value.status_code == 404
        with pytest.raises(HTTPError) as error:
            await manager.start("bob", *manager.project_root(""))
        assert error.value.status_code == 409
    finally:
        await manager.close()
    assert not manager.sessions


async def test_shutdown_terminates_real_process_group(manager, tmp_path):
    cli = tmp_path / "fake_cli.py"
    cli.write_text(
        "import sys, time\n"
        "sys.stdout.write('starting \\x1b[32mtest\\x1b[0m CLI\\nServer started on port 4242!\\npartial')\n"
        "sys.stdout.flush()\n"
        "time.sleep(120)\n"
    )
    manager.command = [sys.executable, str(cli)]
    session = await manager.start("alice", *manager.project_root(""))
    for _ in range(500):
        if session.theme_port == 4242:
            break
        await asyncio.sleep(0.01)
    assert session.process is not None
    assert session.process.returncode is None
    assert session.theme_port == 4242
    assert list(session.logs) == ["starting test CLI", "Server started on port 4242!"]
    await manager.close()
    assert session.process.returncode is not None
    assert not manager.sessions


async def test_heartbeats_retain_process_then_idle_reaping_allows_reopen(manager, tmp_path, monkeypatch):
    """Live viewers renew a shared process; the last closed viewer lets it expire."""
    cli = tmp_path / "idle_cli.py"
    cli.write_text("import time\ntime.sleep(60)\n")
    manager.command = [sys.executable, str(cli)]
    manager.idle_timeout = 0.2
    monkeypatch.setattr(manager, "_theme_ready", AsyncMock(return_value=True))
    monkeypatch.setattr(manager, "_verify_content_server", AsyncMock())
    try:
        session = await manager.start("alice", *manager.project_root(""))
        assert await manager.start("alice", *manager.project_root("")) is session
        for _ in range(4):
            await asyncio.sleep(0.1)
            assert manager.get(session.id, "alice") is session
        assert session.state == "ready"
        assert session.process.returncode is None

        async def expired():
            while session.id in manager.sessions:
                await asyncio.sleep(0.02)

        await asyncio.wait_for(expired(), 5)
        assert session.process.returncode is not None
        replacement = await manager.start("alice", *manager.project_root(""))
        assert replacement.id != session.id
    finally:
        await manager.close()
    assert not manager.sessions


async def test_orphaned_child_cannot_hang_a_stopped_session(manager, tmp_path, monkeypatch, loopback_server):
    """A grandchild holding the log pipe must not keep a dead session 'ready'."""

    class Content(web.RequestHandler):
        def get(self):
            self.finish({"version": "test", "links": {}})

    _, theme_port = loopback_server([(r"/(.*)", Capabilities)])
    _, content_port = loopback_server([(r"/", Content)])
    ports = iter([theme_port, content_port])
    monkeypatch.setattr(mystra, "free_port", lambda: next(ports))
    cli = tmp_path / "fake_cli.py"
    cli.write_text(
        "import subprocess, sys, time\n"
        "child = subprocess.Popen(['sleep', '60'])\n"
        "print('theme up', flush=True)\n"
        "time.sleep(1)\n"
        "sys.exit(3)\n"
    )
    manager.command = [sys.executable, str(cli)]
    try:
        session = await manager.start("alice", *manager.project_root(""))
        await asyncio.wait_for(session.task, 15)
        assert session.state == "failed"
        assert "MyST stopped (exit 3)" in session.message
        assert "theme up" in session.logs
    finally:
        await manager.close()


async def until(condition, timeout=15):
    """Wait for a condition the supervisor reaches asynchronously."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        assert asyncio.get_running_loop().time() < deadline, "condition not reached"
        await asyncio.sleep(0.02)


@pytest.fixture
def building_cli(manager, tmp_path, monkeypatch, loopback_server):
    """A CLI creating the given build folders on each launch, behind a theme and content server.

    Like MyST, the theme answers only once the site is built.
    """

    class Content(web.RequestHandler):
        def get(self):
            self.finish({"version": "test", "links": {}})

    class BuiltCapabilities(Capabilities):
        def get(self, path):
            if not (tmp_path / "_build" / "site").is_dir():
                raise web.HTTPError(503)
            super().get(path)

    _, theme_port = loopback_server([(r"/(.*)", BuiltCapabilities)])
    _, content_port = loopback_server([(r"/", Content)])
    ports = iter([theme_port, content_port])
    monkeypatch.setattr(mystra, "free_port", lambda: next(ports))
    manager.build_check_interval = 0.02
    launches = tmp_path / "launches"

    def cli(*folders):
        script = tmp_path / "building_cli.py"
        script.write_text(
            "import os, time\n"
            f"for folder in {list(folders)!r}:\n"
            "    os.makedirs(folder, exist_ok=True)\n"
            f"with open({str(launches)!r}, 'a') as log:\n"
            "    log.write('launch\\n')\n"
            "time.sleep(60)\n"
        )
        manager.command = [sys.executable, str(script)]
        return lambda: len(launches.read_text().splitlines()) if launches.exists() else 0

    return cli


@pytest.mark.parametrize(
    "removed", ["_build", "_build/site", "_build/templates"]
)
async def test_removing_the_build_rebuilds_in_place(manager, tmp_path, building_cli, removed):
    """Deleting what MyST serves restarts it under the same session, which rebuilds it."""
    launched = building_cli("_build/templates", "_build/site")
    try:
        session = await manager.start("alice", *manager.project_root(""))
        await until(lambda: session.state == "ready")
        assert launched() == 1
        shutil.rmtree(tmp_path / removed)
        await until(lambda: launched() == 2 and session.state == "ready")
        assert manager.get(session.id, "alice") is session
        assert session.payload()["launch"] == 2
        assert (tmp_path / removed).is_dir()
        assert "MySTRA: the build output was removed; rebuilding it." in session.logs
    finally:
        await manager.close()


async def test_a_theme_without_downloaded_templates_is_not_rebuilt(manager, building_cli):
    """A local theme leaves no _build/templates, which must not read as a removal."""
    launched = building_cli("_build/site")
    try:
        session = await manager.start("alice", *manager.project_root(""))
        await until(lambda: session.state == "ready")
        await asyncio.sleep(20 * manager.build_check_interval)
        assert launched() == 1
        assert session.state == "ready"
    finally:
        await manager.close()


async def test_reports_a_stolen_content_port(manager, tmp_path, monkeypatch, loopback_server):
    _, theme_port = loopback_server([(r"/(.*)", Capabilities)])
    ports = iter([theme_port, mystra.free_port()])
    monkeypatch.setattr(mystra, "free_port", lambda: next(ports))
    cli = tmp_path / "fake_cli.py"
    cli.write_text("import time\ntime.sleep(60)\n")
    manager.command = [sys.executable, str(cli)]
    try:
        session = await manager.start("alice", *manager.project_root(""))
        await asyncio.wait_for(session.task, 15)
        assert session.state == "failed"
        assert "content port" in session.message
    finally:
        await manager.close()


@pytest.fixture
def jp_base_url():
    return "/user/researcher/"


@pytest.mark.parametrize(
    "endpoint,method",
    [
        ("sessions", "POST"),
        ("sessions/" + "a" * 32, "GET"),
        ("a" * 32 + "/site/", "GET"),
        ("a" * 32 + "/content/config.json", "GET"),
    ],
)
async def test_requires_auth(jp_fetch, endpoint, method):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        endpoint,
        method=method,
        body="{}" if method == "POST" else None,
        headers={"Authorization": ""},
        follow_redirects=False,
        raise_error=False,
    )
    assert response.code in (302, 403)


async def test_start_requires_execution_authorization(
    jp_fetch, jp_serverapp, monkeypatch
):
    calls = []

    def authorize(handler, user, action, resource):
        calls.append((action, resource))
        return action != "execute"

    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", authorize)
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "sessions",
        method="POST",
        body='{"path":""}',
        raise_error=False,
    )
    assert response.code == 403
    assert ("execute", "mystra") in calls


async def test_start_requires_read_authorization(jp_fetch, jp_serverapp, monkeypatch):
    monkeypatch.setattr(
        jp_serverapp.authorizer, "is_authorized", lambda h, u, a, r: r != "contents"
    )
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "sessions",
        method="POST",
        body='{"path":""}',
        raise_error=False,
    )
    assert response.code == 403


async def test_project_missing_returns_actionable_error(jp_fetch):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "sessions",
        method="POST",
        body='{"path":""}',
        raise_error=False,
    )
    assert response.code == 404
    assert "myst.yml" in json.loads(response.body)["message"]


@pytest.mark.parametrize("directory, status", [("publication", 200), (".hidden", 404)])
async def test_start_checks_readable_config_before_launching(
    jp_fetch, jp_serverapp, monkeypatch, directory, status
):
    """Start readable projects while retaining the ContentsManager's hidden-file policy."""
    project = Path(jp_serverapp.contents_manager.root_dir) / directory
    project.mkdir()
    (project / "myst.yml").write_text("version: 1\n")
    manager = jp_serverapp.web_app.settings["jupyterlab_lightcone_mystra"].manager
    run = AsyncMock()
    monkeypatch.setattr(manager, "_run", run)
    response = await jp_fetch(
        "jupyterlab_lightcone", "mystra", "sessions",
        method="POST", body=json.dumps({"path": directory}), raise_error=False,
    )
    assert response.code == status
    if status == 200:
        payload = json.loads(response.body)
        session = manager.sessions[payload["id"]]
        try:
            await session.task
            run.assert_awaited_once_with(session)
            assert session.project == project
            assert payload["path"] == "publication/myst.yml"
            assert payload["state"] == "starting"
        finally:
            await manager.stop(session)
    else:
        run.assert_not_awaited()
        assert not manager.sessions


async def test_proxy_preserves_html_and_filters_credentials(
    jp_fetch, jp_serverapp, loopback_server, ready_viewer_session
):
    captured = []

    class Theme(web.RequestHandler):
        def get(self, path):
            captured.append(self.request)
            self.set_header("Content-Type", "text/html")
            self.set_header("X-Remix-Redirect", "/elsewhere")
            self.finish("<!doctype html><p>Publication</p>")

    _, port = loopback_server([(r"/(.*)", Theme)])
    session = ready_viewer_session(port)
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        session.id,
        "site",
        "page",
        headers={"Cookie": "not-for-the-theme=private"},
        params={"_data": "routes/$", "token": jp_serverapp.identity_provider.token},
    )
    assert response.code == 200
    assert response.headers["Content-Type"].startswith("text/html")
    assert response.body == b"<!doctype html><p>Publication</p>"
    assert response.headers["Content-Security-Policy"] == "frame-ancestors 'self'"
    assert response.headers["X-Remix-Redirect"] == "/elsewhere"
    assert "Authorization" not in captured[0].headers
    assert "Cookie" not in captured[0].headers
    assert "token=" not in captured[0].query
    assert "_data=" in captured[0].query
    assert captured[0].path == session.prefix + "/site/page"


async def test_a_session_is_only_its_owners(jp_fetch, ready_viewer_session):
    session = ready_viewer_session(mystra.free_port())
    assert (await jp_fetch("jupyterlab_lightcone", "mystra", "sessions", session.id)).code == 200
    session.owner = "someone-else"
    response = await jp_fetch("jupyterlab_lightcone", "mystra", "sessions", session.id, raise_error=False)
    assert response.code == 404


async def test_socket_rejects_anonymous_upgrade(jp_fetch):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "a" * 32,
        "socket",
        headers={
            "Authorization": "",
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
        follow_redirects=False,
        raise_error=False,
    )
    assert response.code == 403


async def test_delete_unknown_session_is_idempotent(jp_fetch):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "sessions",
        "b" * 32,
        method="DELETE",
        raise_error=False,
    )
    assert response.code == 204


async def test_proxy_reports_a_dead_theme_as_bad_gateway(jp_fetch, ready_viewer_session):
    session = ready_viewer_session(mystra.free_port())
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        session.id,
        "site",
        "page",
        raise_error=False,
    )
    assert response.code == 502
    assert "unavailable" in json.loads(response.body)["message"]


async def test_proxy_relays_compression_and_browser_caching(
    jp_fetch, loopback_server, ready_viewer_session
):
    captured = []
    body = gzip.compress(b"console.log('bundle')")

    class Asset(web.RequestHandler):
        def get(self, path):
            captured.append(self.request)
            self.set_header("Content-Type", "text/javascript")
            self.set_header("Content-Encoding", "gzip")
            self.set_header("Vary", "Accept-Encoding")
            self.set_header("Cache-Control", "public, max-age=31536000, immutable")
            self.finish(body)

    _, port = loopback_server([(r"/(.*)", Asset)])
    session = ready_viewer_session(port)
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        session.id,
        "site",
        "build/app.js",
        headers={"Accept-Encoding": "gzip"},
        decompress_response=False,
    )
    assert captured[0].headers["Accept-Encoding"] == "gzip"
    assert response.headers["Content-Encoding"] == "gzip"
    assert response.headers["Vary"] == "Accept-Encoding"
    assert response.headers["Content-Length"] == str(len(body))
    assert response.body == body
    assert response.headers["Cache-Control"] == (
        "private, max-age=31536000, immutable"
    )


def test_socket_handler_keeps_connections_alive():
    assert issubclass(MySTRASocketHandler, WebSocketMixin)
    assert MySTRASocketHandler.check_origin is WebSocketMixin.check_origin
