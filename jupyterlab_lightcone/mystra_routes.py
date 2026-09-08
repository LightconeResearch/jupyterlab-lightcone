"""Authenticated, owner-scoped MySTRA control and transport routes."""

import asyncio
import inspect
from urllib.parse import parse_qsl, urlencode

from jupyter_server.auth import authorized
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from jupyter_server.services.contents.filemanager import FileContentsManager
from tornado import web, websocket
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest


class MySTRARouteHandler(APIHandler):
    """Common session lookup; URLs never accept arbitrary upstream hosts/ports."""

    auth_resource = "contents"

    def initialize(self, manager):
        """Receive the extension-owned process manager."""
        self.manager = manager

    def session(self, identifier):
        """Enforce ownership even when a user can guess another session URL."""
        return self.manager.get(identifier, self.current_user.username)

    def set_default_headers(self):
        """Keep private content out of shared caches."""
        super().set_default_headers()
        self.set_header("Cache-Control", "private, no-store")
        self.set_header("X-Content-Type-Options", "nosniff")


class MySTRASessionsHandler(MySTRARouteHandler):
    """Starting a project executes its configured CLI plugins and theme."""

    @web.authenticated
    @authorized(action="execute", resource="mystra")
    async def post(self):
        """Resolve a readable local project and start/reuse its viewer."""
        allowed = self.authorizer.is_authorized(
            self, self.current_user, "read", "contents"
        )
        if inspect.isawaitable(allowed):
            allowed = await allowed
        if not allowed:
            raise web.HTTPError(
                403, log_message="Reading this project is not authorized"
            )
        if not isinstance(self.contents_manager, FileContentsManager):
            raise web.HTTPError(
                503,
                log_message="MySTRA Viewer requires a local filesystem ContentsManager",
            )
        body = self.get_json_body()
        path = body.get("path", "") if isinstance(body, dict) else None
        _, config_path = await asyncio.to_thread(self.manager.project_root, path)
        readable = self.contents_manager.get(config_path, content=False)
        if inspect.isawaitable(readable):
            await readable
        session = await self.manager.start(self.current_user.username, path)
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
        """Explicitly stop this owner's project process group."""
        await self.manager.stop(self.session(identifier))
        self.set_status(204)
        self.finish()


class MySTRAProxyHandler(MySTRARouteHandler):
    """Read-only forwarding of theme HTML/assets and MyST content."""

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
            for name in (
                "Accept",
                "Range",
                "If-Range",
                "If-None-Match",
                "If-Modified-Since",
            )
            if name in self.request.headers
        }
        headers["Accept-Encoding"] = "identity"
        try:
            response = await AsyncHTTPClient().fetch(
                HTTPRequest(
                    url,
                    method=self.request.method,
                    headers=headers,
                    follow_redirects=False,
                    request_timeout=30,
                ),
                raise_error=False,
            )
        except HTTPClientError as error:
            raise web.HTTPError(
                502, log_message="MySTRA theme is unavailable; check viewer status"
            ) from error
        self.set_status(response.code)
        for name in (
            "Content-Type",
            "Content-Disposition",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "ETag",
            "Last-Modified",
            "Location",
        ):
            if name in response.headers:
                self.set_header(name, response.headers[name])
        # Only this same-origin viewer surface is embeddable, not the rest of Jupyter.
        self.set_header("Content-Security-Policy", "frame-ancestors 'self'")
        if self.request.method != "HEAD" and response.code not in (204, 304):
            self.finish(
                response.body,
                set_content_type=response.headers.get(
                    "Content-Type", "application/octet-stream"
                ),
            )
        else:
            self.finish(
                set_content_type=response.headers.get(
                    "Content-Type", "application/octet-stream"
                )
            )


class MySTRASocketHandler(websocket.WebSocketHandler, MySTRARouteHandler):
    """Relay native reload events after authenticating and checking ownership."""

    upstream = None

    def check_origin(self, origin=""):
        """Use Jupyter's origin policy for both API prepare and WS upgrade."""
        return APIHandler.check_origin(self, origin)

    @ws_authenticated
    @authorized(action="read", resource="contents")
    async def get(self, identifier):
        """Check authorization before upgrading the browser connection."""
        self.session(identifier)
        await super().get(identifier)

    async def open(self, identifier):
        """Connect only to this session's loopback content WebSocket."""
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
            (prefix + "/sessions", MySTRASessionsHandler, options),
            (prefix + "/sessions/" + identifier, MySTRASessionHandler, options),
            (prefix + "/" + identifier + "/socket", MySTRASocketHandler, options),
            (
                prefix + "/" + identifier + r"/(site|content)/(.*)",
                MySTRAProxyHandler,
                options,
            ),
        ],
    )
