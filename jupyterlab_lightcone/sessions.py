"""Project sessions: the Jupyter AI chats stored with a Lightcone project.

A session is a Jupyter Chat document under `<project>/chats/`, where the
workbench creates them. Jupyter Chat's own entry points (its file menu and
launcher) create a chat in the browser's current folder instead, so chats
beside `astra.yaml` are sessions too. This module lists them through the
contents manager, on its terms, with a readable title and message count, and
names the project a chat belongs to; it never creates, deletes or renames a
chat, which the browser does through the Contents API, and never touches the
project's git configuration: the engine's own `.gitignore` template is where
`chats/` has to be ignored.
"""

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import json
from pathlib import PurePosixPath

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from jupyterlab_chat.models import Message, User
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import CHAT_PROJECT, owning_project, project_directory, project_entrypoint, spec_project

CHATS_DIRECTORY = "chats"
"""The project folder that holds sessions."""

PERSONA_PREFIX = "jupyter-ai-personas::"
"""Every Jupyter AI persona's sender ID starts with this."""

CHAT_SUFFIX = ".chat"
MAX_CHAT_BYTES = 2 * 1024 * 1024
TITLE_LENGTH = 80
SUMMARY_CAPACITY = 512
"""How many chat summaries a server keeps; each is a few short strings."""


def contents_join(directory: str, relative: str) -> str:
    """The Contents path of `relative` below a directory's Contents path."""
    return f"{directory}/{relative}" if directory else relative


def chats_directory(project_path: str) -> str:
    """The Contents path of a project's sessions folder, from the project's own."""
    return contents_join(project_path, CHATS_DIRECTORY)


# --- the documents -------------------------------------------------------------


def parse_chat(text: str) -> dict | None:
    """Parse a chat document's text, or return None when it is not a JSON object."""
    try:
        document = json.loads(text)
    except (ValueError, RecursionError):
        # The parser recurses per nesting level, so a deeply nested file
        # exhausts the recursion limit well within the size cap.
        return None
    return document if isinstance(document, dict) else None


async def chat_models(manager, directory: str) -> list[dict]:
    """The chat documents directly inside a Contents directory, as the manager lists them, by name.

    The manager applies its own hidden-file and listing rules. A folder that
    does not exist, is not a folder or cannot be read holds no sessions.
    """
    try:
        listing = await contents_call(manager.get, directory, content=True, type="directory")
    except web.HTTPError as error:
        if error.status_code in (400, 404):
            return []
        raise
    except OSError:
        return []
    return sorted(
        (entry for entry in listing["content"] if entry["type"] == "file" and entry["name"].endswith(CHAT_SUFFIX)),
        key=lambda entry: entry["name"],
    )


async def read_chat(manager, model: dict) -> dict | None:
    """The parsed document of a listed chat, or None when it is too large or not a chat.

    The text is parsed off the event loop: a chat may hold megabytes of agent
    output. A chat removed since it was listed raises the manager's 404.
    """
    size = model.get("size")
    if not isinstance(size, int) or size > MAX_CHAT_BYTES:
        return None
    try:
        full = await contents_call(manager.get, model["path"], content=True, type="file", format="text")
    except web.HTTPError as error:
        if error.status_code == 404:
            raise
        # Not text the manager can serve, or refused: listed by name only.
        return None
    except OSError:
        return None
    content = full.get("content")
    return await asyncio.to_thread(parse_chat, content) if isinstance(content, str) else None


def _messages(document: dict) -> list[Message]:
    """The messages of a chat that fit Jupyter Chat's model and are not deleted.

    Built through the model's own dataclass, so its fields are spelled once;
    an entry that does not fit it, or whose required fields are not text, is
    skipped rather than failing the whole chat.
    """
    entries = document.get("messages")
    if not isinstance(entries, list):
        return []
    messages = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            message = Message(**entry)
        except TypeError:
            continue
        if message.deleted or not all(isinstance(value, str) for value in (message.body, message.sender, message.id)):
            continue
        messages.append(message)
    return messages


def _users(document: dict) -> dict[str, User]:
    """The chat's user map, as Jupyter Chat's model reads it; entries that do not fit are skipped."""
    entries = document.get("users")
    if not isinstance(entries, dict):
        return {}
    users = {}
    for key, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        try:
            users[key] = User(**entry)
        except (TypeError, ValueError):
            continue
    return users


def _is_persona(sender: str) -> bool:
    """Whether a sender ID is a Jupyter AI persona's."""
    return sender.startswith(PERSONA_PREFIX)


def _is_bot(users: dict[str, User], sender: str) -> bool:
    """Whether the chat's own user map marks the sender as a bot (personas and the system user)."""
    user = users.get(sender)
    return user is not None and user.bot is True


def sender_name(users: dict[str, User], sender: str) -> str | None:
    """How the chat's user map names a sender, else the last segment of a persona's ID.

    The model fills an empty display name from the username, so a name equal
    to the username is no name.
    """
    user = users.get(sender)
    if user is not None:
        for name in (user.display_name, user.name):
            if isinstance(name, str) and name.strip() and name != user.username:
                return name.strip()
    return sender.rsplit("::", 1)[-1] if _is_persona(sender) else None


def _first_line(messages: list[Message], users: dict[str, User]) -> str | None:
    """The first line of the first message a person wrote, trimmed to the title length."""
    for message in messages:
        if _is_persona(message.sender) or _is_bot(users, message.sender):
            continue
        for line in message.body.splitlines():
            line = line.strip()
            if line:
                if len(line) > TITLE_LENGTH:
                    line = line[: TITLE_LENGTH - 1].rstrip() + "…"
                return line
    return None


def _last_agent(messages: list[Message], users: dict[str, User]) -> str | None:
    """The display name of the last persona that wrote, or the last segment of its ID."""
    for message in reversed(messages):
        if _is_persona(message.sender):
            return sender_name(users, message.sender)
    return None


@dataclass(frozen=True)
class ChatSummary:
    """What a session listing shows of a chat document.

    Every field is None for a chat that could not be read (too large, not
    text, not a chat): its message count is unknown, not zero.
    """

    title: str | None = None
    """The first line a person wrote; None when nobody did."""
    messages: int | None = None
    """The number of messages the chat still shows."""
    last_agent: str | None = None


def summarize_chat(document: dict | None) -> ChatSummary:
    """Summarize a parsed chat document, reading its messages and users once."""
    if document is None:
        return ChatSummary()
    messages = _messages(document)
    users = _users(document)
    return ChatSummary(
        title=_first_line(messages, users),
        messages=len(messages),
        last_agent=_last_agent(messages, users),
    )


class ChatSummaries:
    """Summaries of chat files, reused while the manager reports them unchanged.

    Sessions are listed on every poll from every open window, so only the
    chats whose modification time or size changed since are read again. The
    least recently listed summaries are dropped beyond `capacity`.
    """

    def __init__(self, capacity: int = SUMMARY_CAPACITY):
        self._capacity = capacity
        self._entries: OrderedDict[str, tuple[tuple, ChatSummary]] = OrderedDict()

    @staticmethod
    def _stamp(model: dict) -> tuple:
        return (model.get("last_modified"), model.get("size"))

    async def summary(self, manager, model: dict) -> ChatSummary:
        """The summary of a listed chat, read only when its file changed; raises the manager's 404."""
        path = model["path"]
        stamp = self._stamp(model)
        cached = self._entries.get(path)
        if cached is not None and cached[0] == stamp:
            self._entries.move_to_end(path)
            return cached[1]
        summary = summarize_chat(await read_chat(manager, model))
        self._entries[path] = (stamp, summary)
        self._entries.move_to_end(path)
        while len(self._entries) > self._capacity:
            self._entries.popitem(last=False)
        return summary


def stem_title(stem: str) -> str:
    """The title of a chat whose messages give none: its file name, made readable."""
    return stem.replace("-", " ").replace("_", " ").strip() or stem


def modified_time(model: dict) -> str:
    """When the chat was last modified, as the manager reports it, in ISO 8601 with milliseconds."""
    return model["last_modified"].isoformat(timespec="milliseconds")


def describe_session(model: dict, summary: ChatSummary) -> dict:
    """One session as the workbench lists it, from the manager's model of the chat and its summary."""
    return {
        "path": model["path"],
        "title": summary.title or stem_title(PurePosixPath(model["name"]).stem),
        "modified": modified_time(model),
        "messages": summary.messages,
        "lastAgent": summary.last_agent,
    }


async def list_sessions(manager, project_path: str, summaries: ChatSummaries) -> list[dict]:
    """Every session of a project, `chats/` and beside `astra.yaml`, newest first.

    A chat that cannot be read is still listed by name; one removed while
    listing is left out.
    """
    sessions = []
    for directory in (chats_directory(project_path), project_path):
        for model in await chat_models(manager, directory):
            try:
                summary = await summaries.summary(manager, model)
            except web.HTTPError as error:
                if error.status_code != 404:
                    raise
                continue
            sessions.append(describe_session(model, summary))
    return sorted(sessions, key=lambda session: (session["modified"], session["path"]), reverse=True)


# --- routes -----------------------------------------------------------------


class ProjectSessionsHandler(ProjectAPIHandler):
    """List a project's sessions."""

    unavailable_message = "Sessions require local files"

    def initialize(self, summaries: ChatSummaries):
        self.summaries = summaries

    @web.authenticated
    @authorized
    async def get(self):
        """List the project's sessions, newest first, with their titles."""
        entrypoint = self.get_query_argument("path")
        await self.project_named(entrypoint)
        sessions = await list_sessions(self.contents_manager, project_directory(entrypoint), self.summaries)
        self.finish({"sessions": sessions})


class ChatProjectHandler(ProjectAPIHandler):
    """Name the project a chat belongs to, as its agent's working directory does.

    The frontend files links and comments under this project, so it must
    agree with `projects.chat_project`: the project storing the chat file,
    else the one recorded in the saved chat. Jupyter Chat sends no chat
    metadata to a browser that opens the chat later, so the record is read
    here.
    """

    unavailable_message = "Chat projects require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """The chat's project entrypoint, or null when it has none yet."""
        root = self.contents_root
        # The manager's read and hidden-file rules, and its 404.
        model = await contents_call(self.contents_manager.get, self.get_query_argument("path"), content=False, type="file")
        project = await asyncio.to_thread(owning_project, root, PurePosixPath(model["path"]).parent)
        if project is None:
            document = await read_chat(self.contents_manager, model)
            metadata = document.get("metadata") if document else None
            recorded = metadata.get(CHAT_PROJECT) if isinstance(metadata, dict) else None
            project = await asyncio.to_thread(spec_project, root, recorded)
        self.finish({"entrypoint": project_entrypoint(root, project) if project else None})


def setup_session_handlers(web_app):
    """Register the sessions routes under the server base URL, including JupyterHub prefixes."""
    base = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    # `chat-sessions`, not `sessions`: Galata's unanchored `Routes.sessions`
    # would mock any URL containing `/api/sessions` in the UI tests.
    web_app.add_handlers(".*$", [
        (url_path_join(base, "chat-sessions"), ProjectSessionsHandler, {"summaries": ChatSummaries()}),
        (url_path_join(base, "chat-project"), ChatProjectHandler),
    ])
