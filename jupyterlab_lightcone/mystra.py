"""Own the CLI process groups used by local MySTRA viewer sessions."""

import asyncio
from collections import deque
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import time
from uuid import uuid4

from jupyter_server.utils import url_path_join
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest
from tornado.web import HTTPError


@dataclass
class ViewerSession:
    """A project process group and its bounded, user-visible status."""

    id: str
    owner: str
    project: Path
    path: str
    prefix: str
    theme_port: int
    content_port: int
    state: str = "starting"
    message: str = "Starting MySTRA…"
    logs: deque = field(default_factory=lambda: deque(maxlen=100))
    touched: float = field(default_factory=time.monotonic)
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = None

    def payload(self):
        """Return the frontend contract and bounded CLI log."""
        return {
            "id": self.id,
            "path": self.path,
            "state": self.state,
            "message": self.message,
            "url": self.prefix + "/site/",
            "logs": list(self.logs),
        }


def free_port():
    """Choose a loopback port; startup verifies that the theme owns its route."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class MySTRAManager:
    """Start on demand, reuse per owner/project, and reap abandoned viewers."""

    def __init__(
        self, root, base_url, command, log, idle_timeout=120, startup_timeout=120
    ):
        self.root = Path(root).resolve()
        self.base_url = base_url
        self.command = command
        self.log = log
        self.idle_timeout = idle_timeout
        self.startup_timeout = startup_timeout
        self.sessions: dict[str, ViewerSession] = {}
        self.lock = asyncio.Lock()
        self.reaper = None
        self.closed = False

    def project_root(self, path):
        """Find the nearest MyST configuration, bounded by the contents root."""
        if not isinstance(path, str) or "\\" in path or "\x00" in path:
            raise HTTPError(
                400, log_message="A local project contents path is required"
            )
        if path.startswith("/") or any(
            p in ("..", ".") or p.startswith(".") for p in path.split("/") if p
        ):
            raise HTTPError(
                400,
                log_message="Use a visible project path inside the Jupyter contents root",
            )
        target = (self.root / path).resolve()
        if not target.is_relative_to(self.root):
            raise HTTPError(
                403, log_message="The project is outside the Jupyter contents root"
            )
        if not target.exists():
            raise HTTPError(404, log_message="The selected project path does not exist")
        target = target if target.is_dir() else target.parent
        while target.is_relative_to(self.root):
            for name in ("myst.yml", "myst.yaml"):
                config = target / name
                if config.is_file():
                    if not config.resolve().is_relative_to(self.root):
                        raise HTTPError(
                            403,
                            log_message="The MyST configuration is outside the contents root",
                        )
                    return target, config.relative_to(self.root).as_posix()
            if target == self.root:
                break
            target = target.parent
        raise HTTPError(
            404, log_message="No myst.yml or myst.yaml was found in this project"
        )

    async def start(self, owner, path):
        """Atomically reuse or create a session; startup continues in the background."""
        project, config_path = await asyncio.to_thread(self.project_root, path)
        async with self.lock:
            if self.closed:
                raise HTTPError(503, log_message="MySTRA viewer is shutting down")
            for session in self.sessions.values():
                if session.owner == owner and session.project == project:
                    session.touched = time.monotonic()
                    return session
            if any(s.project == project for s in self.sessions.values()):
                raise HTTPError(
                    409,
                    log_message="This project is already running in another Jupyter login session",
                )
            if len(self.sessions) >= 5:
                raise HTTPError(
                    429,
                    log_message="Close an existing MySTRA viewer before opening another project",
                )
            identifier = uuid4().hex
            prefix = url_path_join(
                self.base_url, "jupyterlab_lightcone", "mystra", identifier
            )
            theme_port = free_port()
            content_port = free_port()
            while content_port == theme_port:
                content_port = free_port()
            session = ViewerSession(
                identifier,
                owner,
                project,
                config_path,
                prefix,
                theme_port,
                content_port,
            )
            self.sessions[identifier] = session
            session.task = asyncio.create_task(self._run(session))
            if self.reaper is None:
                self.reaper = asyncio.create_task(self._reap())
            return session

    def get(self, identifier, owner):
        """Resolve an opaque session only for its creator."""
        session = self.sessions.get(identifier)
        if session is None or session.owner != owner:
            raise HTTPError(404, log_message="MySTRA viewer session not found")
        session.touched = time.monotonic()
        return session

    async def _read_logs(self, session):
        """Drain stdout continuously so verbose builds never block their process."""
        while chunk := await session.process.stdout.read(4096):
            text = re.sub(
                r"\x1b\[[0-?]*[ -/]*[@-~]", "", chunk.decode(errors="replace")
            )
            session.logs.extend(text.splitlines())

    async def _run(self, session):
        reader = None
        client = AsyncHTTPClient(force_instance=True)
        try:
            if not self.command or not shutil.which(self.command[0]):
                raise RuntimeError(
                    "MyST CLI is unavailable. Install Node.js and MyST in the Jupyter server environment, or configure LightconeApp.mystra_command."
                )
            env = dict(
                os.environ,
                HOST="127.0.0.1",
                CI="true",
                MYSTRA_BASE_URL=session.prefix + "/site",
                MYSTRA_CONTENT_URL=session.prefix + "/content",
                MYSTRA_RELOAD_URL=session.prefix + "/socket",
            )
            session.process = await asyncio.create_subprocess_exec(
                *self.command,
                "start",
                "--port",
                str(session.theme_port),
                "--server-port",
                str(session.content_port),
                cwd=session.project,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=os.name != "nt",
            )
            reader = asyncio.create_task(self._read_logs(session))
            deadline = time.monotonic() + self.startup_timeout
            url = f"http://127.0.0.1:{session.theme_port}{session.prefix}/site/mystra-capabilities"
            while time.monotonic() < deadline:
                if session.process.returncode is not None:
                    raise RuntimeError(
                        "MyST exited during startup. Check the build log below."
                    )
                try:
                    response = await client.fetch(
                        HTTPRequest(url, request_timeout=2, follow_redirects=False),
                        raise_error=False,
                    )
                    if response.code == 200:
                        capability = json.loads(response.body)
                        if (
                            capability.get("protocol") == "mystra-viewer.v1"
                            and capability.get("baseUrl") == session.prefix + "/site"
                        ):
                            session.state = "ready"
                            session.message = "MySTRA viewer is running"
                            break
                    if response.code == 404:
                        raise RuntimeError(
                            "This project needs an ASTRA article or book theme with MySTRA viewer support (mystra-viewer.v1). Update site.template in myst.yml."
                        )
                except (HTTPClientError, OSError, ValueError):
                    pass
                await asyncio.sleep(0.25)
            else:
                raise RuntimeError(
                    "MySTRA startup timed out. Check the log, theme dependencies, and configured startup timeout."
                )
            await session.process.wait()
            await reader
            raise RuntimeError(
                f"MyST stopped (exit {session.process.returncode}). Restart the viewer to continue."
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            session.state = "failed"
            session.message = str(error)
        finally:
            client.close()
            await self._terminate(session)
            if reader:
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)

    async def _terminate(self, session):
        """Stop descendants even when the CLI parent exited unexpectedly."""
        process = session.process
        if process is None:
            return
        if os.name == "nt":
            # Windows has no POSIX process groups. taskkill operates only on our PID tree.
            if process.returncode is None:
                killer = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await killer.wait()
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(process.wait(), 3)
            except asyncio.TimeoutError:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()

    async def stop(self, session):
        """Finish process cleanup before another request can restart the project."""
        async with self.lock:
            if session.task:
                session.task.cancel()
                await asyncio.gather(session.task, return_exceptions=True)
            self.sessions.pop(session.id, None)

    async def _reap(self):
        """Heartbeats expire after browser loss, including failed sessions."""
        while True:
            await asyncio.sleep(min(30, self.idle_timeout))
            expired = [
                s
                for s in self.sessions.values()
                if time.monotonic() - s.touched > self.idle_timeout
            ]
            await asyncio.gather(*(self.stop(s) for s in expired))

    async def close(self):
        """Called by the Jupyter ExtensionApp shutdown lifecycle."""
        self.closed = True
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)
        await asyncio.gather(*(self.stop(s) for s in list(self.sessions.values())))
