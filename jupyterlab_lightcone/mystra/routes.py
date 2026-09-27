"""Authenticated, owner-scoped MySTRA control and transport routes."""

import asyncio
from urllib.parse import parse_qsl, urlencode, urlsplit

from jupyter_server.auth import authorized
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyter_server.utils import ensure_async, url_path_join
from tornado import web, websocket
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest

# Request headers a browser may send that are safe to relay to a local theme.
FORWARDED_REQUEST_HEADERS = (
    "Accept",
    "Accept-Encoding",
    "Range",
    "If-Range",
    "If-None-Match",
    "If-Modified-Since",
)
# Response headers relayed verbatim; Cache-Control is rewritten separately.
FORWARDED_RESPONSE_HEADERS = (
    "Content-Type",
    "Content-Disposition",
    "Content-Length",
    "Content-Encoding",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Location",
    "Vary",
)


class MySTRASessionLookup:
    """Owner-scoped session resolution shared by HTTP and WebSocket handlers."""

    auth_resource = "contents"

    def initialize(self, manager):
        """Receive the extension-owned process manager."""
        self.manager = manager

    def session(self, identifier):
        """Enforce ownership even when a user can guess another session URL."""
        return self.manager.get(identifier, self.current_user.username)


class MySTRARouteHandler(MySTRASessionLookup, APIHandler):
    """Common HTTP behavior; URLs never accept arbitrary upstream hosts/ports."""

    def set_default_headers(self):
        """Keep private content out of shared caches while allowing revalidation."""
        super().set_default_headers()
        self.set_header("Cache-Control", "private, no-cache")
        self.set_header("X-Content-Type-Options", "nosniff")


class MySTRASessionsHandler(MySTRARouteHandler):
    """Starting a project executes its configured CLI plugins and theme."""

    @web.authenticated
    @authorized(action="execute", resource="mystra")
    @authorized(action="read", resource="contents")
    async def post(self):
        """Resolve a readable local project and start/reuse its viewer."""
        if not isinstance(self.contents_manager, FileContentsManager):
            raise web.HTTPError(
                503,
                log_message="MySTRA Viewer requires a local filesystem ContentsManager",
            )
        body = self.get_json_body()
        path = body.get("path", "") if isinstance(body, dict) else None
        project, config_path = await asyncio.to_thread(
            self.manager.project_root, path
        )
        # The contents manager applies the server's hidden-file policy.
        await ensure_async(self.contents_manager.get(config_path, content=False))
        session = await self.manager.start(
            self.current_user.username, project, config_path
        )
        self.finish(session.payload())


class MySTRASessionHandler(MySTRARouteHandler):
    """Status polling also leases a process while a viewer is open."""

    @web.authenticated
    @authorized
    def get(self, identifier):
        """Return state, public URL and bounded build logs."""
        self.finish(self.session(identifier).payload())

    @web.authenticated
    @authorized(action="execute", resource="mystra")
    async def delete(self, identifier):
        """Stop this owner's project process group; unknown sessions are already stopped."""
        session = self.manager.sessions.get(identifier)
        if session is not None and session.owner == self.current_user.username:
            await self.manager.stop(session)
        self.set_status(204)
        self.finish()


class MySTRAProxyHandler(MySTRARouteHandler):
    """Read-only forwarding of theme HTML/assets and MyST content."""

    def check_xsrf_cookie(self):
        """Allow browser resource reads from this user's own Jupyter pages.

        Jupyter Server's own check already lets a GET or HEAD through on its
        Referer (`check_referer`); JupyterHub's replaces that check and refuses
        cookie-authenticated requests in CORS mode, including module imports
        and fonts, which cannot add an XSRF header. So, for a GET or HEAD the
        browser marks same-origin, the Referer must name this server's host
        and a path within its base URL, since another Hub user's page shares
        our origin. The browser's same-origin mark already covers the scheme:
        an HTTPS page may reach us as HTTP behind a TLS-terminating proxy.
        `check_referer` cannot test the host here: the Hub runs this check
        while it authenticates, and `check_referer` asks for the current user.
        Authentication, authorization and session ownership still apply.
        """
        if not self._same_server_resource_read():
            super().check_xsrf_cookie()

    def _same_server_resource_read(self):
        """A GET/HEAD the browser marks same-origin, from a page of this server."""
        referer = self.request.headers.get("Referer")
        if not (
            referer
            and self.request.method in {"GET", "HEAD"}
            and self.request.headers.get("Sec-Fetch-Site") == "same-origin"
        ):
            return False
        try:
            parsed = urlsplit(referer)
        except ValueError:
            return False
        return (
            parsed.scheme in {self.request.protocol, "https"}
            and parsed.netloc == self.request.headers.get("Host")
            and parsed.path.startswith(self.base_url.rstrip("/") + "/")
        )

    @web.authenticated
    @authorized
    async def get(self, identifier, service, path):
        """Forward a GET without Jupyter cookies, tokens, or response rewriting."""
        await self._proxy(identifier, service, path)

    @web.authenticated
    @authorized
    async def head(self, identifier, service, path):
        """Preserve HEAD semantics for downloads and media clients."""
        await self._proxy(identifier, service, path)

    async def _proxy(self, identifier, service, path):
        """Relay one request to the session's loopback theme or content server.

        Bodies pass through untouched, including any upstream compression, so
        the forwarded validators and lengths stay accurate.
        """
        session = self.session(identifier)
        if session.state != "ready":
            raise web.HTTPError(503, log_message=session.message)
        if service == "site":
            port = session.theme_port
            upstream_path = self.request.path
        else:
            port = session.content_port
            upstream_path = self.request.path[len(session.prefix + "/content") :]
        # A browser may carry Jupyter's token in the URL; it must not reach themes.
        query = urlencode(
            [
                (k, v)
                for k, v in parse_qsl(self.request.query, keep_blank_values=True)
                if k not in {"token", "_xsrf"}
            ]
        )
        url = f"http://127.0.0.1:{port}{upstream_path}" + ("?" + query if query else "")
        headers = {
            name: self.request.headers[name]
            for name in FORWARDED_REQUEST_HEADERS
            if name in self.request.headers
        }
        try:
            response = await AsyncHTTPClient().fetch(
                HTTPRequest(
                    url,
                    method=self.request.method,
                    headers=headers,
                    follow_redirects=False,
                    decompress_response=False,
                    request_timeout=30,
                ),
                raise_error=False,
            )
        except (HTTPClientError, OSError) as error:
            raise web.HTTPError(
                502, log_message="MySTRA theme is unavailable; check viewer status"
            ) from error
        self.set_status(response.code)
        for name in response.headers:
            # Remix carries client-side navigation redirects and status in X-Remix-*.
            if name in FORWARDED_RESPONSE_HEADERS or name.lower().startswith("x-remix-"):
                self.set_header(name, response.headers[name])
        # Hashed theme assets may be cached by the browser, never by shared caches.
        if "Cache-Control" in response.headers:
            self.set_header(
                "Cache-Control",
                response.headers["Cache-Control"].replace("public", "private"),
            )
        # Only this same-origin viewer surface is embeddable, not the rest of Jupyter.
        self.set_header("Content-Security-Policy", "frame-ancestors 'self'")
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        if self.request.method != "HEAD" and response.code not in (204, 304):
            self.finish(response.body, set_content_type=content_type)
        else:
            self.finish(set_content_type=content_type)


class MySTRASocketHandler(
    MySTRASessionLookup, WebSocketMixin, websocket.WebSocketHandler, JupyterHandler
):
    """Relay native reload events after authenticating and checking ownership.

    Jupyter's WebSocketMixin supplies the origin policy and keepalive pings that
    stop proxies from dropping a quiet reload channel.
    """

    upstream = None

    @ws_authenticated
    @authorized(action="read", resource="contents")
    async def get(self, identifier):
        """Check authorization before upgrading the browser connection."""
        self.session(identifier)
        await super().get(identifier)

    async def open(self, identifier):
        """Connect only to this session's loopback content WebSocket."""
        super().open(identifier)
        session = self.session(identifier)
        try:
            self.upstream = await websocket.websocket_connect(
                f"ws://127.0.0.1:{session.content_port}/socket",
                connect_timeout=5,
                on_message_callback=self._message,
            )
            if self.ws_connection is None:
                self.upstream.close()
        except (HTTPClientError, OSError):
            self.close(1011, "MySTRA reload connection unavailable")

    def _message(self, message):
        """Forward upstream frames and mirror an upstream close."""
        if message is None:
            self.close()
        elif self.ws_connection is not None:
            self.write_message(message, binary=isinstance(message, bytes))

    def on_message(self, message):
        """The reload channel is server-to-browser only."""

    def on_close(self):
        """Dispose the upstream connection when its iframe goes away."""
        if self.upstream:
            self.upstream.close()


def setup_mystra_handlers(web_app, manager):
    """Register control and transport beneath the active Jupyter base URL."""
    prefix = url_path_join(manager.base_url, "jupyterlab_lightcone", "mystra")
    options = {"manager": manager}
    identifier = r"([a-f0-9]{32})"
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(prefix, "sessions"), MySTRASessionsHandler, options),
            (url_path_join(prefix, "sessions", identifier), MySTRASessionHandler, options),
            (url_path_join(prefix, identifier, "socket"), MySTRASocketHandler, options),
            (
                url_path_join(prefix, identifier, r"(site|content)", r"(.*)"),
                MySTRAProxyHandler,
                options,
            ),
        ],
    )
