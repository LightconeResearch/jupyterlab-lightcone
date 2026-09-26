"""Fixtures the MySTRA route tests share: loopback upstream servers and a ready, owner-scoped viewer session."""

import pytest
from jupyter_server.auth import User
from jupyter_server.utils import url_path_join
from tornado import httpserver, web
from tornado.testing import bind_unused_port

from jupyterlab_lightcone.mystra import ViewerSession

SESSION_ID = "a" * 32
OWNER = "owner"


@pytest.fixture
def loopback_server(jp_asyncio_loop):
    """Start loopback tornado servers on unused ports; each is stopped, connections closed, at teardown."""
    servers = []

    def serve(handlers):
        sock, port = bind_unused_port()
        server = httpserver.HTTPServer(web.Application(handlers))
        server.add_socket(sock)
        servers.append((server, sock))
        return server, port

    yield serve
    for server, sock in servers:
        server.stop()
        jp_asyncio_loop.run_until_complete(server.close_all_connections())
        sock.close()


@pytest.fixture
def ready_viewer_session(jp_serverapp, jp_base_url, monkeypatch):
    """Seed ready viewer sessions in the server's own manager, owned by the user every request comes from.

    Ownership is exercised: the token-authenticated requests of the tests are
    given the session owner's username, so the manager's scoping applies.
    """
    manager = jp_serverapp.web_app.settings["jupyterlab_lightcone"].manager
    monkeypatch.setattr(
        jp_serverapp.identity_provider, "generate_anonymous_user", lambda handler: User(username=OWNER)
    )
    seeded = []

    def ready(port, identifier=SESSION_ID):
        session = ViewerSession(
            identifier,
            OWNER,
            jp_serverapp.root_dir,
            "myst.yml",
            url_path_join(jp_base_url, "jupyterlab_lightcone", "mystra", identifier),
            port,
            port,
            state="ready",
        )
        manager.sessions[identifier] = session
        seeded.append(identifier)
        return session

    yield ready
    for identifier in seeded:
        manager.sessions.pop(identifier, None)
