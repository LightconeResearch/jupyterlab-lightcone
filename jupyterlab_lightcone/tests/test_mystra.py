"""Viewer path boundaries, real process cleanup, and authenticated API behavior."""

import asyncio
import json
import logging
import sys

import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone.mystra import MySTRAManager


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


def _serve(handlers):
    """Start a loopback tornado server and return it with its port."""
    from tornado import httpserver, web

    server = httpserver.HTTPServer(web.Application(handlers))
    server.listen(0, address="127.0.0.1")
    return server, next(iter(server._sockets.values())).getsockname()[1]


async def test_orphaned_child_cannot_hang_a_stopped_session(
    manager, tmp_path, monkeypatch
):
    """A grandchild holding the log pipe must not keep a dead session 'ready'."""
    from tornado import web
    from jupyterlab_lightcone import mystra

    class Capabilities(web.RequestHandler):
        def get(self, path):
            self.finish(
                {
                    "protocol": "mystra-viewer.v1",
                    "baseUrl": self.request.path.rsplit("/site", 1)[0] + "/site",
                }
            )

    class Content(web.RequestHandler):
        def get(self):
            self.finish({"version": "test", "links": {}})

    theme, theme_port = _serve([(r"/(.*)", Capabilities)])
    content, content_port = _serve([(r"/", Content)])
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
        theme.stop()
        content.stop()
        await manager.close()


async def test_reports_a_stolen_content_port(manager, tmp_path, monkeypatch):
    from tornado import web
    from jupyterlab_lightcone import mystra

    class Capabilities(web.RequestHandler):
        def get(self, path):
            self.finish(
                {
                    "protocol": "mystra-viewer.v1",
                    "baseUrl": self.request.path.rsplit("/site", 1)[0] + "/site",
                }
            )

    theme, theme_port = _serve([(r"/(.*)", Capabilities)])
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
        theme.stop()
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
    jp_fetch, jp_serverapp, monkeypatch
):
    from tornado import httpserver, web
    from jupyterlab_lightcone.mystra import ViewerSession

    captured = []

    class Theme(web.RequestHandler):
        def get(self, path):
            captured.append(self.request)
            self.set_header("Content-Type", "text/html")
            self.finish("<!doctype html><p>Publication</p>")

    server = httpserver.HTTPServer(web.Application([(r"/(.*)", Theme)]))
    server.listen(0, address="127.0.0.1")
    port = next(iter(server._sockets.values())).getsockname()[1]
    identifier = "a" * 32
    prefix = f"/user/researcher/jupyterlab_lightcone/mystra/{identifier}"
    session = ViewerSession(
        identifier,
        "owner",
        jp_serverapp.root_dir,
        "myst.yml",
        prefix,
        port,
        port,
        state="ready",
    )
    manager = jp_serverapp.web_app.settings["jupyterlab_lightcone"].manager
    monkeypatch.setattr(manager, "get", lambda identifier, owner: session)
    try:
        response = await jp_fetch(
            "jupyterlab_lightcone",
            "mystra",
            identifier,
            "site",
            "page",
            headers={"Cookie": "not-for-the-theme=private"},
            params={"_data": "routes/$", "token": jp_serverapp.identity_provider.token},
        )
        assert response.code == 200
        assert response.headers["Content-Type"].startswith("text/html")
        assert response.body == b"<!doctype html><p>Publication</p>"
        assert response.headers["Content-Security-Policy"] == "frame-ancestors 'self'"
        assert "Authorization" not in captured[0].headers
        assert "Cookie" not in captured[0].headers
        assert "token=" not in captured[0].query
        assert "_data=" in captured[0].query
        assert captured[0].path == prefix + "/site/page"
    finally:
        server.stop()
        await server.close_all_connections()


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


def _ready_session(jp_serverapp, port):
    from jupyterlab_lightcone.mystra import ViewerSession

    identifier = "a" * 32
    prefix = f"/user/researcher/jupyterlab_lightcone/mystra/{identifier}"
    return ViewerSession(
        identifier,
        "owner",
        jp_serverapp.root_dir,
        "myst.yml",
        prefix,
        port,
        port,
        state="ready",
    )


async def test_proxy_reports_a_dead_theme_as_bad_gateway(
    jp_fetch, jp_serverapp, monkeypatch
):
    from jupyterlab_lightcone.mystra import free_port

    session = _ready_session(jp_serverapp, free_port())
    manager = jp_serverapp.web_app.settings["jupyterlab_lightcone"].manager
    monkeypatch.setattr(manager, "get", lambda identifier, owner: session)
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
    jp_fetch, jp_serverapp, monkeypatch
):
    import gzip
    from tornado import web

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

    server, port = _serve([(r"/(.*)", Asset)])
    session = _ready_session(jp_serverapp, port)
    manager = jp_serverapp.web_app.settings["jupyterlab_lightcone"].manager
    monkeypatch.setattr(manager, "get", lambda identifier, owner: session)
    try:
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
    finally:
        server.stop()
        await server.close_all_connections()


def test_socket_handler_keeps_connections_alive():
    from jupyter_server.base.websocket import WebSocketMixin
    from jupyterlab_lightcone.mystra_routes import MySTRASocketHandler

    assert issubclass(MySTRASocketHandler, WebSocketMixin)
    assert MySTRASocketHandler.check_origin is WebSocketMixin.check_origin
