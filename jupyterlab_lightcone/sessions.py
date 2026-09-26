"""Project sessions: the Jupyter AI chats stored with a Lightcone project.

A session is a Jupyter Chat document under `<project>/chats/`, where the
workbench creates them. Jupyter Chat's own entry points (its file menu and
launcher) create a chat in the browser's current folder instead, so chats
beside `astra.yaml` are sessions too. This module lists them through the
contents manager, on its terms, with a readable title and message count;
it never creates, deletes or renames a chat, which the
browser does through the Contents API, and never touches the project's git
configuration: the engine's own `.gitignore` template is where `chats/` has to
be ignored.
"""

import json
from pathlib import PurePosixPath

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from jupyterlab_chat.models import Message, User
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .projects import project_directory

CHATS_DIRECTORY = "chats"
"""The project folder that holds sessions."""

PERSONA_PREFIX = "jupyter-ai-personas::"
"""Every Jupyter AI persona's sender ID starts with this."""

CHAT_SUFFIX = ".chat"
MAX_CHAT_BYTES = 2 * 1024 * 1024
TITLE_LENGTH = 80


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

    A chat removed since it was listed raises the manager's 404.
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
    return parse_chat(content) if isinstance(content, str) else None


async def chat_documents(manager, project_path: str) -> list[tuple[dict, dict | None]]:
    """Every chat of a project with its parsed document, `chats/` first, then those beside `astra.yaml`.

    A document is None when the chat cannot be parsed, so the chat is still
    listed by name. A chat removed while listing is left out.
    """
    documents = []
    for directory in (chats_directory(project_path), project_path):
        for model in await chat_models(manager, directory):
            try:
                documents.append((model, await read_chat(manager, model)))
            except web.HTTPError as error:
                if error.status_code != 404:
                    raise
    return documents


def _messages(document: dict | None) -> list[Message]:
    """The messages of a chat that fit Jupyter Chat's model and are not deleted.

    Built through the model's own dataclass, so its fields are spelled once;
    an entry that does not fit it, or whose required fields are not text, is
    skipped rather than failing the whole chat.
    """
    entries = document.get("messages") if document else None
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


def _users(document: dict | None) -> dict[str, User]:
    """The chat's user map, as Jupyter Chat's model reads it; entries that do not fit are skipped."""
    entries = document.get("users") if document else None
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


def stem_title(stem: str) -> str:
    """The title of a chat whose messages give none: its file name, made readable."""
    return stem.replace("-", " ").replace("_", " ").strip() or stem


def session_title(document: dict | None, stem: str) -> str:
    """The first line of the first message a person wrote, else the file's stem."""
    users = _users(document)
    for message in _messages(document):
        if _is_persona(message.sender) or _is_bot(users, message.sender):
            continue
        for line in message.body.splitlines():
            line = line.strip()
            if line:
                if len(line) > TITLE_LENGTH:
                    line = line[: TITLE_LENGTH - 1].rstrip() + "…"
                return line
    return stem_title(stem)


def last_agent(document: dict | None) -> str | None:
    """The display name of the last persona that wrote, or the last segment of its ID."""
    for message in reversed(_messages(document)):
        if _is_persona(message.sender):
            return sender_name(_users(document), message.sender)
    return None


def message_count(document: dict | None) -> int:
    """The number of messages the chat still shows."""
    return len(_messages(document))


def modified_time(model: dict) -> str:
    """When the chat was last modified, as the manager reports it, in ISO 8601 with milliseconds."""
    return model["last_modified"].isoformat(timespec="milliseconds")


def describe_session(model: dict, document: dict | None) -> dict:
    """One session as the workbench lists it, from the manager's model of the chat and its document."""
    return {
        "path": model["path"],
        "title": session_title(document, PurePosixPath(model["name"]).stem),
        "modified": modified_time(model),
        "messages": message_count(document),
        "lastAgent": last_agent(document),
    }


async def list_sessions(manager, project_path: str) -> list[dict]:
    """Every session of a project, newest first."""
    sessions = [
        describe_session(model, document) for model, document in await chat_documents(manager, project_path)
    ]
    return sorted(sessions, key=lambda session: (session["modified"], session["path"]), reverse=True)


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


# --- routes -----------------------------------------------------------------


class ProjectSessionsHandler(ProjectAPIHandler):
    """List a project's sessions."""

    unavailable_message = "Sessions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """List the project's sessions, newest first, with their titles."""
        entrypoint = self.get_query_argument("path")
        await self.project_named(entrypoint)
        project_path = project_directory(entrypoint)
        sessions = await list_sessions(self.contents_manager, project_path)
        self.finish({"directory": chats_directory(project_path), "sessions": sessions})


def setup_session_handlers(web_app):
    """Register the sessions routes under the server base URL, including JupyterHub prefixes."""
    # `chat-sessions`, not `sessions`: Galata's `Routes.sessions` regex (`/.*\/api\/sessions.../`,
    # @jupyterlab/galata lib/galata.js) is unanchored, so its default kernel-session mock
    # would intercept any route whose URL contains `/api/sessions` in the UI tests.
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "chat-sessions")
    web_app.add_handlers(".*$", [
        (route, ProjectSessionsHandler),
    ])
