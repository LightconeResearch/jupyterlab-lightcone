"""Pending comments on a project's records and files, sent with the next message.

A user pins a note to a figure, the note
waits above the composer, and it goes out with the next chat message. The
store is `<project>/.lightcone/comments.json`, one of the project stores
`project_store` keeps under the folder the engine's `.gitignore` template
ignores, so commenting never dirties the project's Git tree.

Every route resolves the entrypoint through the contents manager, which
authorizes the project. `agent_workspace.py` delivers the pending comments to
the agent through `deliver_comments`. Where a deployment runs another persona
manager, nothing on the server sees the message go out: the composer then
asks the `send` route for the block and appends it to the message itself.
"""

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import math
import os
from pathlib import Path
import uuid

from jupyter_server.auth import User, authorized
from jupyter_server.utils import url_path_join
from tornado import web

from . import project_store
from .project_routes import ProjectAPIHandler
from .project_store import StoreError
from .projects import project_directory
from .results import RESULTS_DIRECTORY
from .versions import open_repository, output_file as locate_output

COMMENT_LOCKS = "lightcone_comment_locks"
"""The web application setting holding one `asyncio.Lock` per project store."""

COMMENT_DELIVERY = "lightconeCommentDelivery"
"""The page configuration option saying how pending comments reach the agent.

``"prompt"`` when Lightcone's persona manager appends them to the prompt it
hands the persona; ``"message"`` otherwise, when the composer appends them to
the message text itself through the ``send`` route.
"""

MAX_SEND_IDS = 200

STORE_VERSION = 1
STORE_NAME = "comments.json"
MAX_STORE_BYTES = 16 * 1024 * 1024
MAX_TEXT_CHARS = 1000
MAX_FIELD_CHARS = 512
MAX_PATH_CHARS = 4096

TARGET_KINDS = ("record", "file")
ANCHOR_TYPES = ("point",)
STATUSES = ("pending", "sent")
VERSION_FIELDS = ("commit", "key", "hash", "label")

CIRCLED_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩"


def timestamp() -> str:
    """The current time as the ISO 8601 UTC string the store and API use."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def store_path(project: Path) -> Path:
    """Where a project keeps its comments; hidden, and ignored by the engine."""
    return project_store.store_path(project, STORE_NAME)


def comment_lock(locks: dict, project: Path) -> asyncio.Lock:
    """The lock serializing every read-modify-write of one project's store.

    Keyed by the project's real path: the routes resolve symlinks, while agent
    delivery keeps the logical path the Contents API shows (a symlinked
    JupyterHub home, for instance). Both must take the same lock for one store.
    """
    return locks.setdefault(os.path.realpath(project), asyncio.Lock())


def relative_path(path: str, project_dir: str) -> str:
    """A Contents path as the agent sees it from the project root."""
    if not project_dir:
        return path
    if path == project_dir:
        return "."
    prefix = f"{project_dir}/"
    return path[len(prefix):] if path.startswith(prefix) else path


# --- validation -------------------------------------------------------------


def _bad(message: str) -> web.HTTPError:
    """The 400 every validation failure answers with."""
    return web.HTTPError(400, message)


def _encodable(value: str, name: str) -> str:
    """Refuse text the UTF-8 store cannot hold, such as a lone surrogate.

    JSON request bodies may escape one (`"\\ud800"`); accepting it would only
    fail later, when the store is written.
    """
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise _bad(f"{name} must be valid Unicode text.") from None
    return value


def _optional_string(value, name: str, limit: int) -> str | None:
    """A bounded string field, or None when it is null."""
    if value is None:
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise _bad(f"{name} must be a string or null.")
    if len(value) > limit:
        raise _bad(f"{name} must be at most {limit} characters.")
    return _encodable(value, name)


def _optional_number(value, name: str) -> float | None:
    """A finite number field, or None when it is null."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise _bad(f"{name} must be a number or null.")
    return value




def validate_text(value) -> str:
    """A comment's note: one to a thousand characters of visible text."""
    if not isinstance(value, str):
        raise _bad("A comment needs a text.")
    text = _encodable(value, "The comment").strip()
    if not text:
        raise _bad("A comment needs a text.")
    if len(text) > MAX_TEXT_CHARS:
        raise _bad(f"A comment holds at most {MAX_TEXT_CHARS} characters.")
    return text


def validate_target(value) -> dict:
    """What the comment is attached to, with the version it was made on."""
    if not isinstance(value, dict):
        raise _bad("A comment needs a target.")
    kind = value.get("kind")
    if kind not in TARGET_KINDS:
        raise _bad("The target kind must be record or file.")
    path = value.get("path")
    if not isinstance(path, str) or not path or "\x00" in path or len(path) > MAX_PATH_CHARS:
        raise _bad("The target needs a Contents path.")
    _encodable(path, "The target path")
    record = _optional_string(value.get("record"), "record", MAX_FIELD_CHARS)
    if record is not None and (not record or any(character.isspace() for character in record)):
        raise _bad("A record path holds no whitespace.")
    universe = _optional_string(value.get("universe"), "universe", MAX_FIELD_CHARS)
    if kind == "record" and record is None:
        raise _bad("A record target names its record.")
    version = value.get("version")
    if version is None:
        version = {}
    if not isinstance(version, dict):
        raise _bad("The target version must be an object.")
    return {
        "kind": kind,
        "path": path,
        "record": record,
        "universe": universe,
        "version": {
            field: _optional_string(version.get(field), f"version.{field}", MAX_FIELD_CHARS)
            for field in VERSION_FIELDS
        },
    }


def validate_anchor(value) -> dict:
    """Where inside the target the comment sits."""
    if not isinstance(value, dict):
        raise _bad("A comment needs an anchor.")
    kind = value.get("type")
    if kind not in ANCHOR_TYPES:
        raise _bad("The anchor type must be point.")
    anchor = {
        "type": kind,
        "x": _optional_number(value.get("x"), "x"),
        "y": _optional_number(value.get("y"), "y"),
    }
    for axis in ("x", "y"):
        if anchor[axis] is not None and not 0 <= anchor[axis] <= 100:
            raise _bad(f"{axis} is a percentage between 0 and 100.")
    if kind == "point" and (anchor["x"] is None or anchor["y"] is None):
        raise _bad("A point anchor needs x and y.")
    return anchor


def validate_draft(value) -> dict:
    """The body of a create request: text, target and anchor."""
    if not isinstance(value, dict):
        raise _bad("A comment is an object with text, target and anchor.")
    return {
        "text": validate_text(value.get("text")),
        "target": validate_target(value.get("target")),
        "anchor": validate_anchor(value.get("anchor")),
    }


def validate_patch(value) -> dict:
    """The body of an update request: a new text, a new anchor, or both."""
    if not isinstance(value, dict) or not value:
        raise _bad("An update names a text or an anchor.")
    patch = {}
    if "text" in value:
        patch["text"] = validate_text(value["text"])
    if "anchor" in value:
        patch["anchor"] = validate_anchor(value["anchor"])
    if not patch:
        raise _bad("An update names a text or an anchor.")
    return patch


def _stored_comment(value) -> dict:
    """Re-validate a stored comment so a hand-edited store cannot poison the API."""
    if not isinstance(value, dict):
        raise ValueError("A comment must be an object.")
    comment = validate_draft(value)
    comment["text"] = value["text"]
    identifier, created, updated = value.get("id"), value.get("created"), value.get("updated")
    author, status, sent_with, label = (
        value.get("author"), value.get("status"), value.get("sentWith"), value.get("label")
    )
    if not isinstance(identifier, str) or not identifier or not isinstance(created, str):
        raise ValueError("A comment needs an id and a creation time.")
    if updated is not None and not isinstance(updated, str):
        raise ValueError("The update time must be a string or null.")
    if not isinstance(author, str) or status not in STATUSES:
        raise ValueError("A comment needs an author and a status.")
    if sent_with is not None and (
        not isinstance(sent_with, dict)
        or not isinstance(sent_with.get("chat"), str)
        or not (sent_with.get("message") is None or isinstance(sent_with.get("message"), str))
    ):
        raise ValueError("sentWith names a chat and, when known, a message.")
    if isinstance(label, bool) or not isinstance(label, int) or label < 1:
        raise ValueError("A label is a positive integer.")
    # The draft fields were checked above; the store must be able to write these back too.
    sent = (sent_with["chat"], sent_with.get("message")) if sent_with is not None else ()
    for field in (identifier, created, updated, author, *sent):
        if field is not None:
            _encodable(field, "A stored field")
    return {
        "id": identifier,
        "created": created,
        "updated": updated,
        "author": author,
        "status": status,
        "sentWith": None if sent_with is None else {"chat": sent_with["chat"], "message": sent_with.get("message")},
        "label": label,
        **comment,
    }


# --- store ------------------------------------------------------------------


def read_store(path: Path) -> list[dict]:
    """Load a project's comments; a missing store is an empty one.

    Raises `StoreError`: 503 when the store cannot be read, 500 when it is
    not this module's store, the code an unusable local store gets here as in
    `provenance`.
    """
    store = project_store.read_json(path, MAX_STORE_BYTES)
    if store is None:
        return []
    try:
        if not isinstance(store, dict) or store.get("version") != STORE_VERSION:
            raise ValueError("Unsupported store version")
        comments = store.get("comments")
        if not isinstance(comments, list):
            raise ValueError("Comments must be a list")
        return [_stored_comment(comment) for comment in comments]
    except (ValueError, web.HTTPError) as error:
        raise StoreError("The comment store has an unsupported format.", 500) from error


def write_store(path: Path, comments: list[dict]) -> None:
    """Replace the store atomically, so a crash leaves the previous version.

    A store larger than `read_store` accepts is refused (`StoreError`, 413)
    before anything is written: it would make every route, deletion included,
    fail.
    """
    payload = {"version": STORE_VERSION, "comments": comments}
    project_store.write_json(path, payload, limit=MAX_STORE_BYTES, ensure_ascii=False, indent=2)


@contextmanager
def store_errors():
    """Inside a request, answer a store that cannot be read or written with the status it maps to."""
    try:
        yield
    except StoreError as error:
        raise web.HTTPError(error.status, str(error)) from error


def group_key(target: dict) -> tuple[str, str | None]:
    """Pending labels are unique per target path and record."""
    return target["path"], target["record"]


def renumber(comments: list[dict]) -> None:
    """Give the pending comments of each target the labels 1..k in creation order."""
    counters: dict[tuple[str, str | None], int] = {}
    for comment in sorted(
        (comment for comment in comments if comment["status"] == "pending"),
        key=lambda comment: comment["created"],
    ):
        key = group_key(comment["target"])
        counters[key] = counters.get(key, 0) + 1
        comment["label"] = counters[key]


def new_comment(draft: dict, author: str, comments: list[dict]) -> dict:
    """A pending comment with the next free label among its target's pending ones."""
    key = group_key(draft["target"])
    taken = [
        comment["label"]
        for comment in comments
        if comment["status"] == "pending" and group_key(comment["target"]) == key
    ]
    return {
        "id": str(uuid.uuid4()),
        "created": timestamp(),
        "updated": None,
        "author": author,
        "status": "pending",
        "sentWith": None,
        "label": max(taken, default=0) + 1,
        "text": draft["text"],
        "target": draft["target"],
        "anchor": draft["anchor"],
    }


def select_comments(comments: list[dict], status: str, target: str | None) -> list[dict]:
    """Filter a listing by status (`all` keeps both) and, optionally, by target path."""
    return [
        comment
        for comment in comments
        if (status == "all" or comment["status"] == status)
        and (target is None or comment["target"]["path"] == target)
    ]


def find_comment(comments: list[dict], comment_id: str) -> dict:
    """The comment with this id, or a 404."""
    for comment in comments:
        if comment["id"] == comment_id:
            return comment
    raise web.HTTPError(404, "No such comment.")


# --- the prompt block --------------------------------------------------------


def universe_names(project: Path) -> list[str]:
    """The universes with a results folder, in name order; none when there are no results yet."""
    results = project / RESULTS_DIRECTORY
    try:
        return sorted(entry.name for entry in results.iterdir() if entry.is_dir())
    except OSError:
        return []


def output_file(project: Path, record: str, universe: str | None) -> str | None:
    """The project-relative result file of an output record, when one exists.

    A root record `outputs.<id>` names an output, whose file the versions routes
    locate (`versions.output_file`): as the spec declares it, or as the last
    commit holds it. Without a universe, the first universe holding the file
    is used. None when the record is no output's, or no file is there.
    """
    parts = record.split(".")
    # Engine result files belong to the root analysis. A nested record may
    # reuse its ID, but must never borrow that root output's artifact.
    if len(parts) != 2 or parts[0] != "outputs":
        return None
    output = parts[-1]
    universes = [universe] if universe is not None else universe_names(project)
    repository = open_repository(project)
    try:
        for name in universes:
            try:
                file, _ = locate_output(project, name, output, repository)
            except web.HTTPError:
                # Not an identity, not declared, not committed: no file in this universe.
                continue
            if (project / file).exists():
                return file
        return None
    finally:
        if repository is not None:
            repository.close()


def output_files(project: Path, comments: list[dict]) -> dict[str, str | None]:
    """Resolve the result file of every output record among these comments."""
    files = {}
    for comment in comments:
        target = comment["target"]
        if target["kind"] == "record":
            files[comment["id"]] = output_file(project, target["record"], target["universe"])
    return files


def _marker(index: int) -> str:
    """The number of an entry in the block: circled up to ten, in parentheses beyond."""
    return CIRCLED_NUMBERS[index - 1] if index <= len(CIRCLED_NUMBERS) else f"({index})"


def _percent(value: float) -> str:
    """A coordinate as the whole percentage the block prints."""
    return str(round(value))




def describe_comment(comment: dict, project_dir: str, file: str | None) -> str:
    """One line of the prompt block: target, version, position and note."""
    target, anchor, text = comment["target"], comment["anchor"], comment["text"]
    label = target["version"]["label"]
    if target["kind"] == "record":
        head = target["record"]
        details = [part for part in (file, f"version {label}" if label else None) if part]
    else:
        head = relative_path(target["path"], project_dir)
        details = [f"version {label}"] if label else []
    if details:
        head = f"{head} ({', '.join(details)})"
    return f'{head} — point at {_percent(anchor["x"])}% across, {_percent(anchor["y"])}% down: "{text}"'


def format_comment_block(comments: list[dict], project_dir: str, files: dict[str, str | None]) -> str:
    """The block appended to the user's message, one numbered entry per comment.

    A note written over several lines keeps its line breaks; its later lines
    are indented under the entry so that every entry still starts with its
    number.
    """
    lines = [f"Comments on this project ({len(comments)}):"]
    for index, comment in enumerate(comments, 1):
        first, *rest = describe_comment(comment, project_dir, files.get(comment["id"])).splitlines()
        lines.append(f"{_marker(index)} {first}")
        lines.extend(f"   {line}" if line else "" for line in rest)
    return "\n".join(lines)


async def deliver_comments(
    locks: dict, project: Path, project_dir: str, ids: list[str], chat: str, message_id: str | None
) -> str | None:
    """Mark the pending comments among `ids` sent with a message; return their block.

    Missing and already sent ids are skipped. Returns None when nothing was
    pending, so the message goes out unchanged. The message id is None when
    the composer appends the block before the message exists. A store that
    cannot be read or written raises `StoreError`; the caller says what that
    means where it runs.
    """
    path = store_path(project)
    wanted = set(ids)
    async with comment_lock(locks, project):
        comments = await asyncio.to_thread(read_store, path)
        sending = [
            comment for comment in comments
            if comment["id"] in wanted and comment["status"] == "pending"
        ]
        if not sending:
            return None
        files = await asyncio.to_thread(output_files, project, sending)
        block = format_comment_block(sending, project_dir, files)
        for comment in sending:
            comment["status"] = "sent"
            comment["sentWith"] = {"chat": chat, "message": message_id}
        renumber(comments)
        await asyncio.to_thread(write_store, path, comments)
    return block


# --- routes -----------------------------------------------------------------


def author_of(user: User) -> str:
    """The name a comment records for its author: the requesting user's username."""
    return user.username


class CommentAPIHandler(ProjectAPIHandler):
    """Shared store access for the comment routes."""

    unavailable_message = "Comments require local files"

    def locks(self) -> dict:
        """The server's map of one lock per project store, created with the routes."""
        return self.settings.setdefault(COMMENT_LOCKS, {})

    @property
    def author(self) -> str:
        """The requesting user's name; the verbs are authenticated, so there is one."""
        return author_of(self.current_user)


class CommentsHandler(CommentAPIHandler):
    """List a project's comments, or add one."""

    @web.authenticated
    @authorized(action="read", resource="contents")
    async def get(self):
        """Pending comments by default; `status=sent|all` and `target=<path>` narrow or widen."""
        project = await self.project()
        status = self.get_query_argument("status", "pending")
        if status not in (*STATUSES, "all"):
            raise web.HTTPError(400, "status must be pending, sent or all.")
        target = self.get_query_argument("target", None)
        with store_errors():
            async with comment_lock(self.locks(), project):
                comments = await asyncio.to_thread(read_store, store_path(project))
        self.finish({"comments": select_comments(comments, status, target)})

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """Save a pending comment with the next label on its target."""
        body = self.get_json_body()
        # The base class's preamble authorizes the entrypoint; a non-object body is a 400 there.
        project = await self.project_named(body.get("path") if isinstance(body, dict) else None)
        draft = validate_draft(body.get("comment"))
        with store_errors():
            path = store_path(project)
            async with comment_lock(self.locks(), project):
                comments = await asyncio.to_thread(read_store, path)
                comment = new_comment(draft, self.author, comments)
                comments.append(comment)
                await asyncio.to_thread(write_store, path, comments)
        self.set_status(201)
        self.finish(comment)


def validate_send(body) -> tuple[list[str], str]:
    """The comment ids and the chat of a send request."""
    if not isinstance(body, dict):
        raise _bad("A send request is an object.")
    ids, chat = body.get("ids"), body.get("chat")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > MAX_SEND_IDS
        or not all(isinstance(identifier, str) and identifier for identifier in ids)
    ):
        raise _bad(f"A send request names 1 to {MAX_SEND_IDS} comment ids.")
    if not isinstance(chat, str) or not chat or len(chat) > MAX_PATH_CHARS:
        raise _bad("A send request names the chat the comments go to.")
    _encodable(chat, "The chat path")
    for identifier in ids:
        _encodable(identifier, "A comment id")
    return ids, chat


class CommentsSendHandler(CommentAPIHandler):
    """Mark pending comments sent and return their block, for a composer that appends it itself."""

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """`{"path", "ids", "chat"}` → `{"block"}`; the block is null when none was pending."""
        body = self.get_json_body()
        entrypoint = body.get("path") if isinstance(body, dict) else None
        project = await self.project_named(entrypoint)
        ids, chat = validate_send(body)
        with store_errors():
            block = await deliver_comments(self.locks(), project, project_directory(entrypoint), ids, chat, None)
        self.finish({"block": block})


class CommentHandler(CommentAPIHandler):
    """Edit or delete one pending comment."""

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def patch(self, comment_id):
        """Change the text or anchor of a pending comment; sent ones are history."""
        project = await self.project()
        patch = validate_patch(self.get_json_body())
        with store_errors():
            path = store_path(project)
            async with comment_lock(self.locks(), project):
                comments = await asyncio.to_thread(read_store, path)
                comment = find_comment(comments, comment_id)
                if comment["status"] != "pending":
                    raise web.HTTPError(409, "This comment was already sent.")
                comment.update(patch)
                comment["updated"] = timestamp()
                await asyncio.to_thread(write_store, path, comments)
        self.finish(comment)

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def delete(self, comment_id):
        """Remove a pending comment and close the gap in its target's labels."""
        project = await self.project()
        with store_errors():
            path = store_path(project)
            async with comment_lock(self.locks(), project):
                comments = await asyncio.to_thread(read_store, path)
                comment = find_comment(comments, comment_id)
                if comment["status"] != "pending":
                    raise web.HTTPError(409, "This comment was already sent.")
                comments.remove(comment)
                renumber(comments)
                await asyncio.to_thread(write_store, path, comments)
        self.set_status(204)
        self.finish()


def setup_comment_handlers(web_app):
    """Register the comment routes under the server base URL, including JupyterHub prefixes."""
    web_app.settings.setdefault(COMMENT_LOCKS, {})
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api")
    web_app.add_handlers(".*$", [
        (url_path_join(api, "comments"), CommentsHandler),
        # Before the id route, which would otherwise take "send" for an id.
        (url_path_join(api, "comments", "send"), CommentsSendHandler),
        (url_path_join(api, "comments", r"([\w-]+)"), CommentHandler),
    ])
