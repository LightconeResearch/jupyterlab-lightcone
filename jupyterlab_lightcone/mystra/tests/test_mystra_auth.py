"""Browser resource requests with real local and JupyterHub cookie authentication."""

import base64
import hashlib
from types import SimpleNamespace

import pytest
from jupyter_server.auth import User
from jupyter_server.base.handlers import JupyterHandler
from tornado import httpserver, web

# The Hub's XSRF patching can only be exercised with the real HubOAuth; an
# environment without JupyterHub (the `test` extra) skips this module.
pytest.importorskip("jupyterhub")
from jupyterhub.services.auth import HubOAuth
from jupyterhub.singleuser.extension import JupyterHubIdentityProvider


@pytest.fixture
def http_server(jp_asyncio_loop, http_server_port, jp_web_app):
    """Honor forwarded schemes as the real Hub single-user server does."""
    async def start_server():
        server = httpserver.HTTPServer(jp_web_app, xheaders=True)
        server.add_socket(http_server_port[0])
        return server

    server = jp_asyncio_loop.run_until_complete(start_server())
    try:
        yield server
    finally:
        server.stop()
        jp_asyncio_loop.run_until_complete(server.close_all_connections())
        http_server_port[0].close()


@pytest.fixture(params=["local", "hub"])
def viewer_environment(request):
    """Exercise standalone Jupyter and the Hub's additional cookie/XSRF checks."""
    return request.param


@pytest.fixture
def jp_base_url(viewer_environment):
    return "/user/researcher/" if viewer_environment == "hub" else "/"


@pytest.fixture
def browser_headers(
    viewer_environment, jp_serverapp, jp_base_url, http_server_client, monkeypatch
):
    """Use signed login cookies; stub only the Hub's remote token lookup."""
    settings = jp_serverapp.web_app.settings
    if viewer_environment == "hub":
        hub = HubOAuth(
            api_token="test-server-token",
            oauth_client_id="test-client",
            base_url=jp_base_url,
            access_scopes={"access:servers"},
        )

        async def user_for_token(token, **kwargs):
            if token == "test-user-token":
                return {
                    "name": "owner",
                    "kind": "user",
                    "admin": False,
                    "groups": [],
                    "scopes": ["access:servers"],
                }
            return None

        monkeypatch.setattr(hub, "user_for_token", user_for_token)
        # Hub patches these base classes during authentication. Register their
        # originals with monkeypatch so local tests keep their normal behavior.
        for cls in (JupyterHandler, web.RequestHandler):
            for name in ("check_xsrf_cookie", "xsrf_token", "_xsrf_token_id"):
                monkeypatch.setattr(cls, name, getattr(cls, name, None), raising=False)
        provider = JupyterHubIdentityProvider(hub_auth=hub)
        monkeypatch.setitem(settings, "identity_provider", provider)
        cookie_name, cookie_value = hub.cookie_name, "test-user-token"
    else:
        provider = jp_serverapp.identity_provider
        monkeypatch.setattr(provider, "cookie_name", "test-local-login")
        cookie_name = provider.cookie_name
        cookie_value = provider.user_to_cookie(User("owner"))

    cookie = web.create_signed_value(
        settings["cookie_secret"], cookie_name, cookie_value
    ).decode()
    return {
        "Authorization": "",  # jp_fetch otherwise injects token authentication
        "Cookie": f"{cookie_name}={cookie}; jupyterhub-session-id=test-session",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Referer": http_server_client.get_url(jp_base_url + "lab"),
    }


@pytest.fixture
def viewer_asset(loopback_server, ready_viewer_session):
    """A real upstream and owner-scoped session, with no process startup."""
    captured = []

    class Asset(web.RequestHandler):
        def get(self, path):
            captured.append(self.request)
            self.set_header("Content-Type", "text/javascript")
            self.finish("export const loaded = true;")

        def head(self, path):
            self.get(path)

    _, port = loopback_server([(r"/(.*)", Asset)])
    return SimpleNamespace(session=ready_viewer_session(port), captured=captured)


@pytest.mark.parametrize(
    "service,path,method",
    [
        ("site", "myst_assets_folder/entry.client.js", "GET"),
        ("site", "mystra-manifest.js", "GET"),
        ("site", "myst_assets_folder/font.woff2", "GET"),
        ("content", "config.json", "GET"),
        ("site", "myst_assets_folder/entry.client.js", "HEAD"),
    ],
)
async def test_browser_resource_cookie_auth(
    jp_fetch, viewer_asset, browser_headers, service, path, method
):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        viewer_asset.session.id,
        service,
        path,
        method=method,
        headers=browser_headers,
    )
    assert response.code == 200
    assert response.body == (
        b"" if method == "HEAD" else b"export const loaded = true;"
    )
    upstream = viewer_asset.captured[0]
    assert "Cookie" not in upstream.headers
    assert "Authorization" not in upstream.headers
    assert "Referer" not in upstream.headers


@pytest.mark.parametrize("viewer_environment", ["hub"], indirect=True)
@pytest.mark.parametrize(
    "page_scheme,forwarded_proto,expected_status",
    [
        ("https", "https", 200),
        # CHP's default forwarding appends its HTTP hop, and Tornado uses the
        # last scheme; without trusted forwarding the scheme is lost entirely.
        ("https", "https,http", 200),
        ("https", None, 200),
        # A page never loses TLS on its way to a server that sees HTTPS.
        ("http", "https", 403),
    ],
)
async def test_hub_resource_auth_behind_tls_proxy(
    jp_fetch, viewer_asset, browser_headers, page_scheme, forwarded_proto, expected_status
):
    """An HTTPS page may reach this server as HTTP behind a TLS-terminating proxy."""
    browser_headers["Referer"] = browser_headers["Referer"].replace(
        "http:", f"{page_scheme}:", 1
    )
    if forwarded_proto is not None:
        browser_headers["X-Forwarded-Proto"] = forwarded_proto
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        viewer_asset.session.id,
        "site",
        "mystra-manifest.js",
        headers=browser_headers,
        raise_error=False,
    )
    assert response.code == expected_status
    assert bool(viewer_asset.captured) == (expected_status == 200)


@pytest.mark.parametrize("viewer_environment", ["hub"], indirect=True)
@pytest.mark.parametrize(
    "referer,site",
    [
        (None, "same-origin"),
        ("https://other.example/user/researcher/lab", "cross-site"),
        ("https://other.example/user/researcher/lab", "same-origin"),
        ("/user/someone-else/lab", "same-origin"),
        ("/user/researcher-other/lab", "same-origin"),
        ("/user/researcher/lab", "same-site"),
        ("/user/researcher/lab", None),
        ("https://[invalid", "same-origin"),
    ],
)
async def test_hub_rejects_resource_reads_without_trusted_page(
    jp_fetch, viewer_asset, browser_headers, http_server_client, referer, site
):
    if referer is None:
        browser_headers.pop("Referer")
    else:
        browser_headers["Referer"] = (
            http_server_client.get_url(referer) if referer.startswith("/") else referer
        )
    if site is None:
        browser_headers.pop("Sec-Fetch-Site")
    else:
        browser_headers["Sec-Fetch-Site"] = site
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        viewer_asset.session.id,
        "site",
        "myst_assets_folder/entry.client.js",
        headers=browser_headers,
        raise_error=False,
        follow_redirects=False,
    )
    assert response.code == 403
    assert not viewer_asset.captured


@pytest.mark.parametrize("restriction", ["anonymous", "other-owner", "denied"])
async def test_resource_exception_keeps_access_checks(
    jp_fetch, jp_serverapp, viewer_asset, browser_headers, monkeypatch, restriction
):
    if restriction == "anonymous":
        browser_headers.pop("Cookie")
    elif restriction == "other-owner":
        viewer_asset.session.owner = "someone-else"
    else:
        monkeypatch.setattr(
            jp_serverapp.authorizer, "is_authorized", lambda *args: False
        )
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        viewer_asset.session.id,
        "site",
        "myst_assets_folder/entry.client.js",
        headers=browser_headers,
        raise_error=False,
        follow_redirects=False,
    )
    assert response.code == (404 if restriction == "other-owner" else 403)
    assert not viewer_asset.captured


@pytest.mark.parametrize("method", ["POST", "DELETE"])
async def test_cookie_control_requests_still_require_xsrf(
    jp_fetch, viewer_asset, browser_headers, method
):
    parts = ["jupyterlab_lightcone", "mystra", "sessions"]
    if method == "DELETE":
        parts.append(viewer_asset.session.id)
    response = await jp_fetch(
        *parts,
        method=method,
        body='{"path":""}' if method == "POST" else None,
        headers=browser_headers,
        raise_error=False,
        follow_redirects=False,
    )
    assert response.code == 403
    assert viewer_asset.session.state == "ready"


@pytest.mark.parametrize("viewer_environment", ["hub"], indirect=True)
async def test_hub_valid_xsrf_still_allows_reads_and_control(
    jp_fetch, jp_serverapp, viewer_asset, browser_headers
):
    """Requests outside the resource exception can still use normal Hub XSRF."""
    token_id = "test-session:" + hashlib.sha256(b"test-user-token").hexdigest()
    xsrf = (
        base64.urlsafe_b64encode(
            web.create_signed_value(
                jp_serverapp.web_app.settings["cookie_secret"], "_xsrf", token_id
            )
        )
        .rstrip(b"=")
        .decode()
    )
    browser_headers["Cookie"] += f"; _xsrf={xsrf}"
    browser_headers["X-Xsrftoken"] = xsrf
    browser_headers.pop("Referer")
    browser_headers.pop("Sec-Fetch-Site")
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        viewer_asset.session.id,
        "site",
        "myst_assets_folder/entry.client.js",
        headers=browser_headers,
    )
    assert response.code == 200
    assert "X-Xsrftoken" not in viewer_asset.captured[0].headers
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "mystra",
        "sessions",
        viewer_asset.session.id,
        method="DELETE",
        headers=browser_headers,
    )
    assert response.code == 204
