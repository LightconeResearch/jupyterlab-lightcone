"""Project sessions: the Jupyter AI chats stored with a Lightcone project.

A session is a Jupyter Chat document under `<project>/chats/` (or, for chats
created before that folder existed, beside `astra.yaml`). This module lists
them with a readable title and prepares a project to hold them; it never
deletes or renames a chat, which the browser does through the Contents API.
"""

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import project_root

SESSION_ACTIVITY = "lightcone_session_activity"
"""The web application setting mapping a chat's Contents path to its live activity.

The persona manager in `agent_workspace` writes `{"state": "working" | "idle",
"persona": <id>, "since": <iso8601>}` there while it processes a message.
"""

CHATS_DIRECTORY = "chats"
"""The project folder that holds sessions."""

PERSONA_PREFIX = "jupyter-ai-personas::"
"""Every Jupyter AI persona's sender ID starts with this."""

CHAT_SUFFIX = ".chat"
MAX_CHAT_BYTES = 2 * 1024 * 1024
TITLE_LENGTH = 80
EXCLUDE_PATTERNS = ("chats/", "*.chat")
GIT_TIMEOUT = 10


def contents_path(root: Path, path: Path) -> str:
    """The Jupyter Contents path of a local path; the root itself is ``''``."""
    relative = path.relative_to(root).as_posix()
    return "" if relative == "." else relative


def chats_directory(root: Path, project: Path) -> str:
    """The Contents path of a project's sessions folder."""
    base = contents_path(root, project)
    return f"{base}/{CHATS_DIRECTORY}" if base else CHATS_DIRECTORY


def read_chat(path: Path) -> dict | None:
    """Parse a chat document, or return None when it is too large or not a chat."""
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_CHAT_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_CHAT_BYTES:
        return None
    try:
        document = json.loads(data)
    except (ValueError, UnicodeError):
        return None
    return document if isinstance(document, dict) else None


def _messages(document: dict | None) -> list[dict]:
    messages = document.get("messages") if document else None
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict) and not message.get("deleted")]


def _users(document: dict | None) -> dict:
    users = document.get("users") if document else None
    return users if isinstance(users, dict) else {}


def _is_persona(sender) -> bool:
    return isinstance(sender, str) and sender.startswith(PERSONA_PREFIX)


def _is_bot(document: dict | None, sender) -> bool:
    """Whether the chat's own user map marks the sender as a bot (personas and the system user)."""
    user = _users(document).get(sender) if isinstance(sender, str) else None
    return isinstance(user, dict) and user.get("bot") is True


def stem_title(stem: str) -> str:
    """The title of a chat whose messages give none: its file name, made readable."""
    return stem.replace("-", " ").replace("_", " ").strip() or stem


def session_title(document: dict | None, stem: str) -> str:
    """The first line of the first message a person wrote, else the file's stem."""
    for message in _messages(document):
        sender = message.get("sender")
        if _is_persona(sender) or _is_bot(document, sender):
            continue
        body = message.get("body")
        if not isinstance(body, str):
            continue
        for line in body.splitlines():
            line = line.strip()
            if line:
                if len(line) > TITLE_LENGTH:
                    line = line[: TITLE_LENGTH - 1].rstrip() + "…"
                return line
    return stem_title(stem)


def last_agent(document: dict | None) -> str | None:
    """The display name of the last persona that wrote, or the last segment of its ID."""
    for message in reversed(_messages(document)):
        sender = message.get("sender")
        if not _is_persona(sender):
            continue
        user = _users(document).get(sender)
        if isinstance(user, dict):
            for key in ("display_name", "name"):
                name = user.get(key)
                if isinstance(name, str) and name.strip():
                    return name.strip()
        return sender.rsplit("::", 1)[-1]
    return None


def message_count(document: dict | None) -> int:
    """The number of messages the chat still shows."""
    return len(_messages(document))


def activity_state(activity: dict, path: str) -> str:
    """The persona manager's live state for a chat: ``working`` or ``idle``."""
    entry = activity.get(path)
    state = entry.get("state") if isinstance(entry, dict) else entry
    return "working" if state == "working" else "idle"


def describe_session(root: Path, path: Path, activity: dict) -> dict:
    """One session as the workbench lists it."""
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    document = read_chat(path)
    location = contents_path(root, path)
    return {
        "path": location,
        "title": session_title(document, path.stem),
        "modified": modified.isoformat(timespec="milliseconds"),
        "messages": message_count(document),
        "lastAgent": last_agent(document),
        "activity": activity_state(activity, location),
    }


def _chat_files(directory: Path) -> list[Path]:
    """The visible chat documents directly inside a folder, in name order."""
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return []
    chats = []
    for entry in entries:
        if entry.name.startswith(".") or not entry.name.endswith(CHAT_SUFFIX):
            continue
        try:
            if entry.is_file():
                chats.append(Path(entry.path))
        except OSError:
            continue
    return sorted(chats)


def list_sessions(root: Path, project: Path, activity: dict) -> list[dict]:
    """Every session of a project, newest first.

    Chats live in `chats/`; those created beside `astra.yaml` before that
    folder existed are still listed, so nothing a user started disappears.
    """
    sessions = []
    for directory in (project / CHATS_DIRECTORY, project):
        for chat in _chat_files(directory):
            try:
                sessions.append(describe_session(root, chat, activity))
            except OSError:
                # A chat removed while listing must not hide the others.
                continue
    return sorted(sessions, key=lambda session: (session["modified"], session["path"]), reverse=True)


def _git(project: Path, *arguments: str) -> str:
    """Run one Git query in the project, without a shell, and return its output."""
    completed = subprocess.run(
        ["git", *arguments],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT,
        check=True,
    )
    return completed.stdout.strip()


def exclude_patterns(project: Path, toplevel: Path) -> list[str]:
    """The exclude rules for a project's chats, relative to the repository root.

    A project that is a repository of its own excludes `/chats/` and `/*.chat`;
    one nested in a larger repository prefixes both with its own folder, so the
    rules keep pointing at the project's chats rather than the repository's.
    """
    relative = project.resolve().relative_to(toplevel.resolve()).as_posix()
    prefix = "" if relative == "." else f"/{relative}"
    return [f"{prefix}/{pattern}" for pattern in EXCLUDE_PATTERNS]


def exclude_chats(project: Path) -> bool:
    """Keep the project's chats out of `git status`, so the engine still runs.

    Appends the missing rules to the repository's `info/exclude`, which stays
    local and never touches the project's own `.gitignore`. Returns whether the
    file was changed; a folder that is not inside a Git repository is left
    alone.
    """
    try:
        toplevel = Path(_git(project, "rev-parse", "--show-toplevel"))
        exclude = project / _git(project, "rev-parse", "--git-path", "info/exclude")
        patterns = exclude_patterns(project, toplevel)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError):
        return False
    try:
        existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    except OSError:
        return False
    present = {line.strip() for line in existing.splitlines()}
    missing = [pattern for pattern in patterns if pattern not in present]
    if not missing:
        return False
    lead = "" if not existing or existing.endswith("\n") else "\n"
    try:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as stream:
            stream.write(lead + "".join(f"{pattern}\n" for pattern in missing))
    except OSError:
        return False
    return True


class ProjectSessionsHandler(ProjectAPIHandler):
    """List a project's sessions, or prepare the project to hold new ones."""

    unavailable_message = "Sessions require local files"

    async def project_named(self, path) -> Path:
        """Resolve and authorize a project from an entrypoint carried in a request body."""
        if not isinstance(path, str):
            raise web.HTTPError(400, "A local astra.yaml path is required")
        root = self.contents_root
        project = project_root(root, path)
        # Apply the contents manager's read and hidden-file rules too.
        await contents_call(self.contents_manager.get, path, content=False, type="file")
        self.set_header("Cache-Control", "no-store")
        return project

    @web.authenticated
    @authorized
    async def get(self):
        """List the project's sessions, newest first, with their live activity."""
        project = await self.project()
        root = self.contents_root
        # Copy the registry so the listing thread never races the persona manager.
        activity = dict(self.settings.get(SESSION_ACTIVITY) or {})
        sessions = await asyncio.to_thread(list_sessions, root, project, activity)
        self.finish({"directory": chats_directory(root, project), "sessions": sessions})

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """Create the project's `chats` folder and keep chats out of its Git status."""
        body = self.get_json_body()
        project = await self.project_named(body.get("path") if isinstance(body, dict) else None)
        directory = chats_directory(self.contents_root, project)
        manager = self.contents_manager
        try:
            await contents_call(manager.get, directory, content=False, type="directory")
        except web.HTTPError as error:
            if error.status_code != 404:
                raise
            # Through the manager, so the browser's file events fire.
            await contents_call(manager.new, model={"type": "directory"}, path=directory)
        if await asyncio.to_thread(exclude_chats, project):
            self.log.info("Excluded chats from the Git status of %s", project)
        self.finish({"directory": directory})


def setup_session_handlers(web_app):
    """Register the sessions route under the server base URL, including JupyterHub prefixes."""
    # Not `api/sessions`: Jupyter clients (Galata among them) treat any URL ending in
    # `/api/sessions` as the kernel-session API.
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "chat-sessions")
    web_app.add_handlers(".*$", [(route, ProjectSessionsHandler)])
