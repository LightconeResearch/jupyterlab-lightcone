"""Viewer path boundaries, real process cleanup, and authenticated API behavior."""

import asyncio
import gzip
import json
import logging
import sys

from jupyter_server.base.websocket import WebSocketMixin
import pytest
from tornado import web
from tornado.web import HTTPError

from jupyterlab_lightcone import mystra
from jupyterlab_lightcone.mystra import MySTRAManager
from jupyterlab_lightcone.mystra_routes import MySTRASocketHandler


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
    return MySTRAManager(
        tmp_path, "/user/researcher/", ["no-such-myst-executable"], logging.getLogger()
    )


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
