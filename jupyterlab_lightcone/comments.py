"""Pending comments on a project's records and files, sent with the next message.

A user pins a note to a figure, a text
selection or a PDF page, the note waits above the composer, and it goes out
with the next chat message. The store is `<project>/.lightcone/comments.json`,
which the engine's `.gitignore` template already ignores, so commenting never
dirties the project's Git tree.

The store is hidden, so it is read from disk rather than through the Contents
API; every route still resolves the entrypoint through the contents manager,
which authorizes the project. `agent_workspace.py` delivers the pending
comments to the agent through `deliver_comments`.
"""

import asyncio
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import uuid

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler

COMMENT_LOCKS = "lightcone_comment_locks"
"""The web application setting holding one `asyncio.Lock` per project store."""

STORE_VERSION = 1
STORE_FILE = Path(".lightcone", "comments.json")
MAX_STORE_BYTES = 16 * 1024 * 1024
MAX_TEXT_CHARS = 1000
MAX_QUOTE_CHARS = 300
MAX_PREFIX_CHARS = 100
MAX_FIELD_CHARS = 512
MAX_PATH_CHARS = 4096

TARGET_KINDS = ("record", "file", "message")
ANCHOR_TYPES = ("point", "text", "pdf")
STATUSES = ("pending", "sent")
VERSION_FIELDS = ("commit", "key", "hash", "label")
POSITION_FIELDS = ("startLine", "startCol", "endLine", "endCol")

CIRCLED_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩"


def timestamp() -> str:
    """The current time as the ISO 8601 UTC string the store and API use."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def store_path(project: Path) -> Path:
    """Where a project keeps its comments; hidden, and ignored by the engine."""
    return project / STORE_FILE


def comment_lock(locks: dict, project: Path) -> asyncio.Lock:
    """The lock serializing every read-modify-write of one project's store.

    Keyed by the project's real path: the routes resolve symlinks, while agent
    delivery keeps the logical path the Contents API shows (a symlinked
    JupyterHub home, for instance). Both must take the same lock for one store.
    """
    return locks.setdefault(os.path.realpath(project), asyncio.Lock())


def project_directory(entrypoint: str) -> str:
    """The Contents path of the project directory named by an entrypoint."""
    suffix = "/astra.yaml"
    return entrypoint[: -len(suffix)] if entrypoint.endswith(suffix) else ""


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
    if value is None:
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise _bad(f"{name} must be a string or null.")
    if len(value) > limit:
        raise _bad(f"{name} must be at most {limit} characters.")
    return _encodable(value, name)


def _optional_number(value, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise _bad(f"{name} must be a number or null.")
    return value


def _optional_int(value, name: str, minimum: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise _bad(f"{name} must be an integer of at least {minimum}, or null.")
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
        raise _bad("The target kind must be record, file or message.")
    path = value.get("path")
    if not isinstance(path, str) or not path or "\x00" in path or len(path) > MAX_PATH_CHARS:
        raise _bad("The target needs a Contents path.")
    _encodable(path, "The target path")
    record = _optional_string(value.get("record"), "record", MAX_FIELD_CHARS)
    if record is not None and (not record or any(character.isspace() for character in record)):
        raise _bad("A record path holds no whitespace.")
    universe = _optional_string(value.get("universe"), "universe", MAX_FIELD_CHARS)
    message = _optional_string(value.get("message"), "message", MAX_FIELD_CHARS)
    if kind == "record" and record is None:
        raise _bad("A record target names its record.")
    if kind == "message" and message is None:
        raise _bad("A message target names its message.")
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
        "message": message,
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
        raise _bad("The anchor type must be point, text or pdf.")
    anchor = {
        "type": kind,
        "x": _optional_number(value.get("x"), "x"),
        "y": _optional_number(value.get("y"), "y"),
        **{field: _optional_int(value.get(field), field, 0) for field in POSITION_FIELDS},
        "quote": _optional_string(value.get("quote"), "quote", MAX_QUOTE_CHARS),
        "prefix": _optional_string(value.get("prefix"), "prefix", MAX_PREFIX_CHARS),
        "page": _optional_int(value.get("page"), "page", 1),
    }
    for axis in ("x", "y"):
        if anchor[axis] is not None and not 0 <= anchor[axis] <= 100:
            raise _bad(f"{axis} is a percentage between 0 and 100.")
    if kind == "point" and (anchor["x"] is None or anchor["y"] is None):
        raise _bad("A point anchor needs x and y.")
    if kind == "text" and anchor["quote"] is None and anchor["startLine"] is None:
        raise _bad("A text anchor needs a quote or a line range.")
    if kind == "pdf" and anchor["page"] is None:
        raise _bad("A PDF anchor needs a page.")
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
        or not isinstance(sent_with.get("message"), str)
    ):
        raise ValueError("sentWith names a chat and a message.")
    if isinstance(label, bool) or not isinstance(label, int) or label < 1:
        raise ValueError("A label is a positive integer.")
    # The draft fields were checked above; the store must be able to write these back too.
    sent = (sent_with["chat"], sent_with["message"]) if sent_with is not None else ()
    for field in (identifier, created, updated, author, *sent):
        if field is not None:
            _encodable(field, "A stored field")
    return {
        "id": identifier,
        "created": created,
        "updated": updated,
        "author": author,
        "status": status,
        "sentWith": None if sent_with is None else {"chat": sent_with["chat"], "message": sent_with["message"]},
        "label": label,
        **comment,
    }


# --- store ------------------------------------------------------------------


def read_store(path: Path) -> list[dict]:
    """Load a project's comments; a missing store is an empty one."""
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_STORE_BYTES + 1)
    except FileNotFoundError:
        return []
    except OSError as error:
        raise web.HTTPError(503, "The comment store could not be read.") from error
    try:
        if len(data) > MAX_STORE_BYTES:
            raise ValueError("Oversized store")
        store = json.loads(data)
        if not isinstance(store, dict) or store.get("version") != STORE_VERSION:
            raise ValueError("Unsupported store version")
        comments = store.get("comments")
        if not isinstance(comments, list):
            raise ValueError("Comments must be a list")
        return [_stored_comment(comment) for comment in comments]
    except (ValueError, UnicodeError, web.HTTPError) as error:
        raise web.HTTPError(500, "The comment store has an unsupported format.") from error


def write_store(path: Path, comments: list[dict]) -> None:
    """Replace the store atomically, so a crash leaves the previous version.

    A store larger than `read_store` accepts is refused with a 413 before
    anything is written: it would make every route, deletion included, fail.
    """
    payload = json.dumps(
        {"version": STORE_VERSION, "comments": comments}, ensure_ascii=False, indent=2
    ).encode("utf-8")
    if len(payload) > MAX_STORE_BYTES:
        raise web.HTTPError(413, "The project's comment store is full.")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".comments-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


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


def output_file(project: Path, record: str, universe: str | None) -> str | None:
    """The project-relative result file of an output record, when one exists.

    Outputs live at `results/<universe>/<id>.<ext>` beside a hidden manifest.
    Without a universe, the first universe holding the file is used.
    """
    parts = record.split(".")
    if len(parts) < 2 or parts[-2] != "outputs":
        return None
    output = parts[-1]
    if not output or any(character in output for character in "./\\"):
        return None
    results = project / "results"
    if universe is not None:
        universes = [universe]
    elif results.is_dir():
        universes = sorted(entry.name for entry in results.iterdir() if entry.is_dir())
    else:
        universes = []
    for name in universes:
        if not name or name.startswith(".") or any(character in name for character in "/\\"):
            continue
        directory = results / name
        if not directory.is_dir():
            continue
        candidates = sorted(
            entry for entry in directory.glob(f"{output}.*")
            if entry.is_file() and not entry.name.startswith(".")
        )
        if candidates:
            return candidates[0].relative_to(project).as_posix()
    return None


def output_files(project: Path, comments: list[dict]) -> dict[str, str | None]:
    """Resolve the result file of every output record among these comments."""
    files = {}
    for comment in comments:
        target = comment["target"]
        if target["kind"] == "record":
            files[comment["id"]] = output_file(project, target["record"], target["universe"])
    return files


def _marker(index: int) -> str:
    return CIRCLED_NUMBERS[index - 1] if index <= len(CIRCLED_NUMBERS) else f"({index})"


def _percent(value: float) -> str:
    return str(round(value))


def _squash(text: str) -> str:
    return " ".join(text.split())


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
    if anchor["type"] == "point":
        return f'{head} — point at {_percent(anchor["x"])}% across, {_percent(anchor["y"])}% down: "{text}"'
    parts = [head]
    if anchor["page"] is not None:
        parts.append(f"page {anchor['page']}")
    if anchor["startLine"] is not None:
        start, end = anchor["startLine"], anchor["endLine"]
        parts.append(f"lines {start}–{end}" if end is not None and end != start else f"line {start}")
    if anchor["quote"] is not None:
        parts.append(f'quoting "{_squash(anchor["quote"])}"')
    return f'{", ".join(parts)} — "{text}"'


def format_comment_block(comments: list[dict], project_dir: str, files: dict[str, str | None]) -> str:
    """The block appended to the user's message, one numbered line per comment."""
    lines = [f"Comments on this project ({len(comments)}):"]
    for index, comment in enumerate(comments, 1):
        lines.append(f"{_marker(index)} {describe_comment(comment, project_dir, files.get(comment['id']))}")
    return "\n".join(lines)


async def deliver_comments(
    locks: dict, project: Path, project_dir: str, ids: list[str], chat: str, message_id: str
) -> str | None:
    """Mark the pending comments among `ids` sent with a message; return their block.

    Missing and already sent ids are skipped. Returns None when nothing was
    pending, so the message goes out unchanged.
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


class CommentAPIHandler(ProjectAPIHandler):
    """Shared store access for the comment routes."""

    unavailable_message = "Comments require local files"

    def locks(self) -> dict:
        return self.settings.setdefault(COMMENT_LOCKS, {})

    @property
    def author(self) -> str:
        """The requesting user's name, or an empty string when the server has none."""
        user = self.current_user
        username = user.get("username") if isinstance(user, dict) else getattr(user, "username", None)
        return username if isinstance(username, str) else ""


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
        path = store_path(project)
        async with comment_lock(self.locks(), project):
            comments = await asyncio.to_thread(read_store, path)
            comment = new_comment(draft, self.author, comments)
            comments.append(comment)
            await asyncio.to_thread(write_store, path, comments)
        self.set_status(201)
        self.finish(comment)


class CommentHandler(CommentAPIHandler):
    """Edit or delete one pending comment."""

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def patch(self, comment_id):
        """Change the text or anchor of a pending comment; sent ones are history."""
        project = await self.project()
        patch = validate_patch(self.get_json_body())
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
        (url_path_join(api, "comments", r"([\w-]+)"), CommentHandler),
    ])
