"""Project sessions: the Jupyter AI chats stored with a Lightcone project.

A session is a Jupyter Chat document under `<project>/chats/` (or, for chats
created before that folder existed, beside `astra.yaml`). This module lists
them with a readable title and creates the folder that holds them; it never
deletes or renames a chat, which the browser does through the Contents API,
and never touches the project's git configuration: the engine's own
`.gitignore` template is where `chats/` has to be ignored.
"""

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import inside_root

SESSION_ACTIVITY = "lightcone_session_activity"
"""The web application setting mapping a chat's Contents path to its live activity.

The one definition of the key: the persona manager in `agent_workspace` writes
`{"state": "working" | "idle", "persona": <id>, "since": <iso8601>}` there,
through `session_activity`, while it processes a message. It lives here
because this module does not need Jupyter AI to be installed.
"""

CHATS_DIRECTORY = "chats"
"""The project folder that holds sessions."""

PERSONA_PREFIX = "jupyter-ai-personas::"
"""Every Jupyter AI persona's sender ID starts with this."""

CHAT_SUFFIX = ".chat"
MAX_CHAT_BYTES = 2 * 1024 * 1024
TITLE_LENGTH = 80
MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 200
MAX_SEARCH_MATCHES = 50
SNIPPET_CONTEXT = 50
"""Characters of a message kept on each side of a search match."""


def project_contents_path(entrypoint: str) -> str:
    """The Contents path of the project an entrypoint names; the root is ``''``.

    Taken from the entrypoint as the browser wrote it, not from the resolved
    folder: a project reached through a symlink inside the root keeps the
    paths under which the browser opens its chats and the persona manager
    records their activity.
    """
    parent = PurePosixPath(entrypoint).parent.as_posix()
    return "" if parent == "." else parent


def project_folder(root: Path, project_path: str) -> Path:
    """The folder on disk that a project's Contents path names, within `root`.

    The folder holding the entrypoint as the browser named it, never the one a
    symlinked `astra.yaml` points into, so the chats read and excluded here are
    those under the paths this module reports.
    """
    return inside_root(root, Path(project_path), "Project is outside the contents root")


def contents_join(directory: str, relative: str) -> str:
    """The Contents path of `relative` below a directory's Contents path."""
    return f"{directory}/{relative}" if directory else relative


def chats_directory(project_path: str) -> str:
    """The Contents path of a project's sessions folder, from the project's own."""
    return contents_join(project_path, CHATS_DIRECTORY)


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
    except (ValueError, UnicodeError, RecursionError):
        # The parser recurses per nesting level, so a deeply nested file
        # exhausts the recursion limit well within the size cap.
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
        if _is_persona(sender):
            return sender_name(document, sender)
    return None


def message_count(document: dict | None) -> int:
    """The number of messages the chat still shows."""
    return len(_messages(document))


def activity_state(activity: dict, path: str) -> str:
    """The persona manager's live state for a chat: ``working`` or ``idle``."""
    entry = activity.get(path)
    state = entry.get("state") if isinstance(entry, dict) else None
    return "working" if state == "working" else "idle"


def describe_session(project_path: str, project: Path, chat: Path, activity: dict) -> dict:
    """One session as the workbench lists it.

    `project` is the folder on disk; `project_path` is its Contents path, from
    which the chat's reported path and its activity key are built.
    """
    modified = datetime.fromtimestamp(chat.stat().st_mtime, tz=timezone.utc)
    document = read_chat(chat)
    location = contents_join(project_path, chat.relative_to(project).as_posix())
    return {
        "path": location,
        "title": session_title(document, chat.stem),
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


def list_sessions(project_path: str, project: Path, activity: dict) -> list[dict]:
    """Every session of a project, newest first.

    Chats live in `chats/`; those created beside `astra.yaml` before that
    folder existed are still listed, so nothing a user started disappears.
    """
    sessions = []
    for directory in (project / CHATS_DIRECTORY, project):
        for chat in _chat_files(directory):
            try:
                sessions.append(describe_session(project_path, project, chat, activity))
            except (OSError, ValueError, OverflowError):
                # A chat removed while listing, or one whose modification time
                # no date can hold, must not hide the others.
                continue
    return sorted(sessions, key=lambda session: (session["modified"], session["path"]), reverse=True)


def sender_name(document: dict | None, sender) -> str | None:
    """How the chat's user map names a sender, else the last segment of a persona's ID."""
    user = _users(document).get(sender) if isinstance(sender, str) else None
    if isinstance(user, dict):
        for key in ("display_name", "name"):
            name = user.get(key)
            if isinstance(name, str) and name.strip():
                return name.strip()
    return sender.rsplit("::", 1)[-1] if _is_persona(sender) else None


def snippet(body: str, start: int, end: int) -> str:
    """The match with some context on each side, on one line, marked where cut."""
    begin = max(0, start - SNIPPET_CONTEXT)
    finish = min(len(body), end + SNIPPET_CONTEXT)
    text = " ".join(body[begin:finish].split())
    return f"{'…' if begin else ''}{text}{'…' if finish < len(body) else ''}"


def message_time(message: dict) -> str | None:
    """A message's time as ISO 8601; Jupyter Chat stores seconds since the epoch."""
    value = message.get("time")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return None


def search_sessions(project_path: str, project: Path, query: str) -> list[dict]:
    """Messages of the project's sessions containing `query`, case-insensitively.

    One match per message, newest first, at most `MAX_SEARCH_MATCHES`; each
    names its session, the message, its author and a snippet around the match.
    """
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    matches = []
    for directory in (project / CHATS_DIRECTORY, project):
        for chat in _chat_files(directory):
            document = read_chat(chat)
            if document is None:
                continue
            location = contents_join(project_path, chat.relative_to(project).as_posix())
            title = session_title(document, chat.stem)
            for message in _messages(document):
                body = message.get("body")
                found = pattern.search(body) if isinstance(body, str) else None
                if found is None:
                    continue
                identifier = message.get("id")
                matches.append({
                    "path": location,
                    "title": title,
                    "message": identifier if isinstance(identifier, str) else None,
                    "author": sender_name(document, message.get("sender")),
                    "agent": _is_persona(message.get("sender")),
                    "time": message_time(message),
                    "snippet": snippet(body, found.start(), found.end()),
                })
    matches.sort(key=lambda match: (match["time"] or "", match["path"]), reverse=True)
    return matches[:MAX_SEARCH_MATCHES]


class ProjectSessionsHandler(ProjectAPIHandler):
    """List a project's sessions, or create the folder that holds new ones."""

    unavailable_message = "Sessions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """List the project's sessions, newest first, with their live activity."""
        entrypoint = self.get_query_argument("path")
        await self.project_named(entrypoint)
        project_path = project_contents_path(entrypoint)
        project = project_folder(self.contents_root, project_path)
        # Copy the registry so the listing thread never races the persona manager.
        activity = dict(self.settings.get(SESSION_ACTIVITY) or {})
        sessions = await asyncio.to_thread(list_sessions, project_path, project, activity)
        self.finish({"directory": chats_directory(project_path), "sessions": sessions})

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """Create the project's `chats` folder, through the contents manager."""
        body = self.get_json_body()
        entrypoint = body.get("path") if isinstance(body, dict) else None
        await self.project_named(entrypoint)
        project_path = project_contents_path(entrypoint)
        directory = chats_directory(project_path)
        manager = self.contents_manager
        try:
            await contents_call(manager.get, directory, content=False, type="directory")
        except web.HTTPError as error:
            if error.status_code != 404:
                raise
            # Through the manager, so the browser's file events fire.
            await contents_call(manager.new, model={"type": "directory"}, path=directory)
        self.finish({"directory": directory})


class SessionSearchHandler(ProjectAPIHandler):
    """Search the text of a project's sessions, for the search modal."""

    unavailable_message = "Sessions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """`?path=<entrypoint>&q=<text>` → `{"matches": [...]}`, newest first."""
        entrypoint = self.get_query_argument("path")
        query = self.get_query_argument("q").strip()
        if not MIN_QUERY_LENGTH <= len(query) <= MAX_QUERY_LENGTH:
            raise web.HTTPError(
                400, f"A search needs {MIN_QUERY_LENGTH} to {MAX_QUERY_LENGTH} characters."
            )
        await self.project_named(entrypoint)
        project_path = project_contents_path(entrypoint)
        project = project_folder(self.contents_root, project_path)
        matches = await asyncio.to_thread(search_sessions, project_path, project, query)
        self.finish({"matches": matches})


def setup_session_handlers(web_app):
    """Register the sessions routes under the server base URL, including JupyterHub prefixes."""
    # Not `api/sessions`: Jupyter clients (Galata among them) treat any URL ending in
    # `/api/sessions` as the kernel-session API.
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "chat-sessions")
    web_app.add_handlers(".*$", [
        (route, ProjectSessionsHandler),
        (url_path_join(route, "search"), SessionSearchHandler),
    ])
