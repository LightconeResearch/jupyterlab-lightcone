"""Comments wait in a hidden project store and reach the agent with the next message."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from jupyter_server.auth import User
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import comments
from jupyterlab_lightcone.projects import owning_project, project_root

ENDPOINT = ("jupyterlab_lightcone", "api", "comments")


def point(text="The legend covers the high-redshift points.", record="outputs.hubble_diagram", universe="baseline", **version):
    """A draft pinning a note on a figure, as the record tab's overlay sends it."""
    return {
        "text": text,
        "target": {
            "kind": "record",
            "path": "astra.yaml",
            "record": record,
            "universe": universe,
            "message": None,
            "version": {"commit": None, "key": None, "hash": None, "label": None, **version},
        },
        "anchor": {
            "type": "point", "x": 42.4, "y": 31, "startLine": None, "startCol": None,
            "endLine": None, "endCol": None, "quote": None, "prefix": None, "page": None,
        },
    }


def selection(text="Explain why the magnitude offset is profiled.", path="index.md", **anchor):
    """A draft quoting a text selection in a project file."""
    return {
        "text": text,
        "target": {
            "kind": "file", "path": path, "record": None, "universe": None, "message": None,
            "version": {"commit": None, "key": None, "hash": "abc", "label": None},
        },
        "anchor": {
            "type": "text", "x": None, "y": None, "startLine": 12, "startCol": 1,
            "endLine": 13, "endCol": 40, "quote": "The analysis specification records the…",
            "prefix": "## Method\n", "page": None, **anchor,
        },
    }


def project(root, name="project"):
    """A project with one materialized figure, beside its hidden manifest."""
    directory = root / name
    (directory / "results" / "baseline").mkdir(parents=True)
    (directory / "astra.yaml").write_text("name: test\n")
    (directory / "results" / "baseline" / "hubble_diagram.png").write_bytes(b"png")
    (directory / "results" / "baseline" / ".hubble_diagram.manifest.json").write_text("{}")
    return directory


def stored(draft, **fields):
    """A comment as the store holds it."""
    comment = comments.new_comment(comments.validate_draft(draft), "researcher", [])
    comment.update(fields)
    return comment


# --- validation -------------------------------------------------------------


def test_a_draft_is_normalized_and_missing_version_fields_become_null():
    draft = point(text="  Move the legend.  ")
    del draft["target"]["version"]
    normalized = comments.validate_draft(draft)
    assert normalized["text"] == "Move the legend."
    assert normalized["target"]["version"] == {"commit": None, "key": None, "hash": None, "label": None}
    assert normalized["anchor"] == draft["anchor"]


def _without_text(draft):
    draft["text"] = "   "


def _too_long(draft):
    draft["text"] = "x" * 1001


def _bad_kind(draft):
    draft["target"]["kind"] = "table"


def _record_without_record(draft):
    draft["target"]["record"] = None


def _message_without_id(draft):
    draft["target"].update(kind="message", message=None)


def _point_without_y(draft):
    draft["anchor"]["y"] = None


def _off_the_image(draft):
    draft["anchor"]["x"] = 101


def _boolean_coordinate(draft):
    draft["anchor"]["x"] = True


def _not_a_number(draft):
    draft["anchor"]["x"] = float("nan")


def _text_without_anchor(draft):
    draft["anchor"].update(type="text", x=None, y=None)


def _pdf_without_page(draft):
    draft["anchor"].update(type="pdf", quote="a claim", page=None)


def _quote_too_long(draft):
    draft["anchor"].update(type="text", quote="q" * 301)


def _record_with_space(draft):
    draft["target"]["record"] = "outputs.hubble diagram"


def _null_byte_in_path(draft):
    draft["target"]["path"] = "a\x00b"


def _line_below_zero(draft):
    draft["anchor"].update(type="text", quote="q", startLine=-1)


# A JSON body may escape a lone surrogate, which the UTF-8 store cannot hold.
def _lone_surrogate_in_text(draft):
    draft["text"] = "Move \ud800 the legend."


def _lone_surrogate_in_path(draft):
    draft["target"]["path"] = "notes\ud800.md"


def _lone_surrogate_in_quote(draft):
    draft["anchor"].update(type="text", quote="\udfff")


def _lone_surrogate_in_version(draft):
    draft["target"]["version"]["label"] = "v\ud800"


@pytest.mark.parametrize("spoil", [
    _without_text, _too_long, _bad_kind, _record_without_record, _message_without_id,
    _point_without_y, _off_the_image, _boolean_coordinate, _not_a_number,
    _text_without_anchor, _pdf_without_page, _quote_too_long, _record_with_space,
    _null_byte_in_path, _line_below_zero, _lone_surrogate_in_text, _lone_surrogate_in_path,
    _lone_surrogate_in_quote, _lone_surrogate_in_version,
])
def test_invalid_drafts_are_rejected(spoil):
    draft = point()
    spoil(draft)
    with pytest.raises(HTTPError) as error:
        comments.validate_draft(draft)
    assert error.value.status_code == 400


@pytest.mark.parametrize("body", [None, {}, {"status": "sent"}, {"text": ""}, {"anchor": {"type": "point"}}])
def test_a_patch_needs_a_valid_text_or_anchor(body):
    with pytest.raises(HTTPError) as error:
        comments.validate_patch(body)
    assert error.value.status_code == 400


def test_a_patch_keeps_only_text_and_anchor():
    patch = comments.validate_patch({"text": " New note ", "status": "sent", "label": 9})
    assert patch == {"text": "New note"}


# --- store ------------------------------------------------------------------


def test_the_store_round_trips_and_a_missing_store_is_empty(tmp_path):
    path = comments.store_path(tmp_path)
    assert comments.read_store(path) == []
    saved = [stored(point()), stored(selection())]
    comments.write_store(path, saved)
    assert path.parent == tmp_path / ".lightcone"
    assert comments.read_store(path) == saved
    assert json.loads(path.read_text())["version"] == 1
    # The atomic replacement leaves no temporary file behind.
    assert sorted(entry.name for entry in path.parent.iterdir()) == ["comments.json"]


@pytest.mark.parametrize("content", [
    b"\xff", b"[]", b'{"version": 2, "comments": []}', b'{"version": 1, "comments": {}}',
    b'{"version": 1, "comments": [{"id": "x"}]}',
])
def test_a_corrupt_store_is_an_error_not_a_silent_loss(tmp_path, content):
    path = comments.store_path(tmp_path)
    path.parent.mkdir()
    path.write_bytes(content)
    with pytest.raises(HTTPError) as error:
        comments.read_store(path)
    assert error.value.status_code == 500


@pytest.mark.parametrize("field, value", [
    ("id", "\ud800"), ("created", "\ud800"), ("updated", "\ud800"), ("author", "\udfff"),
    ("sentWith", {"chat": "talk\ud800.chat", "message": "m0"}),
])
def test_a_stored_field_that_could_not_be_written_back_is_refused(tmp_path, field, value):
    """A hand-edited store may escape a lone surrogate outside the draft fields too."""
    path = comments.store_path(tmp_path)
    path.parent.mkdir()
    comment = stored(point(), status="sent", sentWith={"chat": "talk.chat", "message": "m0"})
    comment[field] = value
    path.write_text(json.dumps({"version": 1, "comments": [comment]}))
    with pytest.raises(HTTPError) as error:
        comments.read_store(path)
    assert error.value.status_code == 500


def test_the_store_is_bounded(tmp_path, monkeypatch):
    path = comments.store_path(tmp_path)
    comments.write_store(path, [stored(point())])
    monkeypatch.setattr(comments, "MAX_STORE_BYTES", 16)
    with pytest.raises(HTTPError):
        comments.read_store(path)


def test_a_write_never_outgrows_what_can_be_read(tmp_path, monkeypatch):
    path = comments.store_path(tmp_path)
    kept = [stored(point())]
    comments.write_store(path, kept)
    monkeypatch.setattr(comments, "MAX_STORE_BYTES", path.stat().st_size)
    with pytest.raises(HTTPError) as error:
        comments.write_store(path, [*kept, stored(point(text="Second"))])
    assert error.value.status_code == 413
    # The previous store is untouched and still readable, with no temporary file left.
    assert comments.read_store(path) == kept
    assert sorted(entry.name for entry in path.parent.iterdir()) == ["comments.json"]


def test_labels_count_pending_comments_per_target_and_close_gaps():
    first = stored(point())
    second = stored(point(text="Second"), created="2999-01-01T00:00:00+00:00")
    other = stored(selection())
    listing = []
    for comment in (first, second, other):
        comment["label"] = comments.new_comment(comment, "", listing)["label"]
        listing.append(comment)
    assert [comment["label"] for comment in listing] == [1, 2, 1]
    listing.remove(first)
    comments.renumber(listing)
    assert [comment["label"] for comment in listing] == [1, 1]
    # Sent comments keep their label and no longer count.
    second["status"] = "sent"
    comments.renumber(listing)
    assert comments.new_comment(point(), "", listing)["label"] == 1
    assert second["label"] == 1


def test_a_stored_text_is_kept_verbatim(tmp_path):
    path = comments.store_path(tmp_path)
    comment = stored(point(text="Two\n\nparagraphs "))
    comment["text"] = "Two\n\nparagraphs"
    comments.write_store(path, [comment])
    assert comments.read_store(path)[0]["text"] == "Two\n\nparagraphs"


# --- the prompt block --------------------------------------------------------


def test_the_result_file_of_an_output_is_found_with_or_without_its_universe(tmp_path):
    root = project(tmp_path)
    (root / "results" / "alt").mkdir()
    (root / "results" / "alt" / "hubble_diagram.svg").write_bytes(b"svg")
    assert comments.output_file(root, "outputs.hubble_diagram", "baseline") == "results/baseline/hubble_diagram.png"
    assert comments.output_file(root, "outputs.hubble_diagram", None) == "results/alt/hubble_diagram.svg"
    assert comments.output_file(root, "sub.outputs.hubble_diagram", "baseline") == "results/baseline/hubble_diagram.png"
    assert comments.output_file(root, "outputs.missing", "baseline") is None
    assert comments.output_file(root, "outputs.hubble_diagram", "../baseline") is None
    assert comments.output_file(root, "decisions.model", "baseline") is None
    assert comments.output_file(root, "outputs.hubble_diagram", ".hidden") is None
    assert comments.output_file(tmp_path / "empty", "outputs.hubble_diagram", None) is None


def test_the_block_names_records_files_versions_positions_and_quotes(tmp_path):
    root = project(tmp_path)
    listing = [
        stored(point(label="a889877")),
        stored(selection(path="project/index.md")),
        stored(selection(
            text="Is this claim supported?", path="project/paper.pdf", type="pdf", page=4,
            startLine=None, endLine=None, quote="  the   Hubble\nconstant ",
        )),
        stored(selection(text="Only a line.", path="elsewhere/notes.md", endLine=None, quote=None, prefix=None)),
    ]
    files = comments.output_files(root, listing)
    assert files == {listing[0]["id"]: "results/baseline/hubble_diagram.png"}
    block = comments.format_comment_block(listing, "project", files)
    assert block == "\n".join([
        "Comments on this project (4):",
        '① outputs.hubble_diagram (results/baseline/hubble_diagram.png, version a889877) — point at 42% across, 31% down: "The legend covers the high-redshift points."',
        '② index.md, lines 12–13, quoting "The analysis specification records the…" — "Explain why the magnitude offset is profiled."',
        '③ paper.pdf, page 4, quoting "the Hubble constant" — "Is this claim supported?"',
        '④ elsewhere/notes.md, line 12 — "Only a line."',
    ])


def test_the_block_omits_what_is_null_and_numbers_beyond_ten_in_parentheses():
    unmaterialized = stored(point(record="decisions.cosmological_model", universe=None))
    assert comments.describe_comment(unmaterialized, "", None) == (
        'decisions.cosmological_model — point at 42% across, 31% down: "The legend covers the high-redshift points."'
    )
    versioned = stored(selection(path="notes.md", startLine=None, endLine=None, quote="claim"))
    versioned["target"]["version"]["label"] = "v2"
    assert comments.describe_comment(versioned, "", None) == (
        'notes.md (version v2), quoting "claim" — "Explain why the magnitude offset is profiled."'
    )
    block = comments.format_comment_block([unmaterialized] * 11, "", {})
    assert block.splitlines()[0] == "Comments on this project (11):"
    assert block.splitlines()[10].startswith("⑩ ")
    assert block.splitlines()[11].startswith("(11) ")


def test_a_note_over_several_lines_stays_under_its_number():
    note = stored(point(text="The legend covers\nthe high-redshift points.\n\nMove it."))
    block = comments.format_comment_block([note, stored(selection(path="notes.md"))], "", {})
    assert block.split("\n") == [
        "Comments on this project (2):",
        '① outputs.hubble_diagram — point at 42% across, 31% down: "The legend covers',
        "   the high-redshift points.",
        "",
        '   Move it."',
        '② notes.md, lines 12–13, quoting "The analysis specification records the…" — "Explain why the magnitude offset is profiled."',
    ]


@pytest.mark.parametrize("path, project_dir, expected", [
    ("project/index.md", "project", "index.md"),
    ("project", "project", "."),
    ("other/index.md", "project", "other/index.md"),
    ("index.md", "", "index.md"),
    ("projects/index.md", "project", "projects/index.md"),
])
def test_paths_are_relative_to_the_project(path, project_dir, expected):
    assert comments.relative_path(path, project_dir) == expected
    assert comments.project_directory("project/astra.yaml") == "project"
    assert comments.project_directory("astra.yaml") == ""


async def test_delivery_marks_only_the_named_pending_comments_sent(tmp_path):
    root = project(tmp_path)
    path = comments.store_path(root)
    sent_before = stored(selection(), status="sent", sentWith={"chat": "old.chat", "message": "m0"})
    first, second, third = stored(point()), stored(point(text="Second")), stored(point(text="Third"))
    second["label"], third["label"] = 2, 3
    comments.write_store(path, [sent_before, first, second, third])
    locks = {}
    block = await comments.deliver_comments(
        locks, root, "project", [first["id"], second["id"], sent_before["id"], "missing"], "project/chats/talk.chat", "m1"
    )
    assert block.startswith("Comments on this project (2):\n① outputs.hubble_diagram")
    assert "Second" in block and "Third" not in block
    after = {comment["id"]: comment for comment in comments.read_store(path)}
    assert after[first["id"]]["status"] == "sent"
    assert after[first["id"]]["sentWith"] == {"chat": "project/chats/talk.chat", "message": "m1"}
    assert after[second["id"]]["status"] == "sent"
    assert after[sent_before["id"]]["sentWith"] == {"chat": "old.chat", "message": "m0"}
    # The remaining pending comment closes the gap in the labels.
    assert after[third["id"]]["status"] == "pending" and after[third["id"]]["label"] == 1
    assert list(locks) == [str(root.resolve())]
    # Nothing pending: the message goes out unchanged.
    assert await comments.deliver_comments(locks, root, "project", [first["id"]], "c", "m2") is None


async def test_delivery_waits_for_a_request_holding_the_lock(tmp_path):
    """Even when the server root is a symlink, as JupyterHub homes often are.

    The routes resolve the project; delivery keeps the logical path the chat
    has. Both name one store, so both must take one lock.
    """
    project(tmp_path / "real")
    home = tmp_path / "home"
    home.symlink_to(tmp_path / "real", target_is_directory=True)
    route = project_root(home.resolve(), "project/astra.yaml")
    chat = owning_project(home, Path("project/chats"))
    assert route != chat
    comments.write_store(comments.store_path(route), [stored(point())])
    locks = {}
    lock = comments.comment_lock(locks, route)
    assert comments.comment_lock(locks, chat) is lock
    await lock.acquire()
    delivery = asyncio.ensure_future(comments.deliver_comments(locks, chat, "project", ["x"], "c", "m"))
    await asyncio.sleep(0.01)
    assert not delivery.done()
    lock.release()
    assert await delivery is None


# --- routes -----------------------------------------------------------------


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return "/user/researcher/"


@pytest.fixture
def served(jp_serverapp):
    """A project inside the served root, with the comment routes registered."""
    assert comments.COMMENT_LOCKS in jp_serverapp.web_app.settings, "application.py must call setup_comment_handlers"
    root = Path(jp_serverapp.contents_manager.root_dir)
    project(root)
    assert not jp_serverapp.contents_manager.allow_hidden
    return root / "project"


def _body(response):
    return json.loads(response.body)


async def _create(jp_fetch, draft, path="project/astra.yaml"):
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": path, "comment": draft}))
    assert response.code == 201
    return _body(response)


async def test_comments_are_created_listed_edited_and_deleted(jp_fetch, served, jp_serverapp, monkeypatch):
    # The shared test token names no user; give its requests a known one.
    monkeypatch.setattr(
        jp_serverapp.identity_provider, "generate_anonymous_user", lambda handler: User(username="researcher")
    )
    first = await _create(jp_fetch, point())
    second = await _create(jp_fetch, point(text="Second"))
    note = await _create(jp_fetch, selection(path="project/index.md"))
    assert (first["label"], second["label"], note["label"]) == (1, 2, 1)
    assert first["status"] == "pending" and first["sentWith"] is None and first["updated"] is None
    assert first["author"] == "researcher"
    assert first["text"] == "The legend covers the high-redshift points."
    assert comments.store_path(served).is_file()

    listing = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert listing.headers["Cache-Control"] == "no-store"
    assert [comment["id"] for comment in _body(listing)["comments"]] == [first["id"], second["id"], note["id"]]
    scoped = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml", "target": "project/index.md"})
    assert [comment["id"] for comment in _body(scoped)["comments"]] == [note["id"]]

    moved = {**first["anchor"], "x": 50, "y": 60}
    edited = await jp_fetch(
        *ENDPOINT, first["id"], method="PATCH", params={"path": "project/astra.yaml"},
        body=json.dumps({"text": "Move the legend.", "anchor": moved}),
    )
    assert _body(edited)["text"] == "Move the legend."
    assert _body(edited)["anchor"] == moved
    assert _body(edited)["updated"] is not None

    deleted = await jp_fetch(*ENDPOINT, first["id"], method="DELETE", params={"path": "project/astra.yaml"})
    assert deleted.code == 204
    remaining = _body(await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"}))["comments"]
    assert [(comment["id"], comment["label"]) for comment in remaining] == [(second["id"], 1), (note["id"], 1)]


async def test_sent_comments_are_history(jp_fetch, served):
    created = await _create(jp_fetch, point())
    store = comments.store_path(served)
    listing = comments.read_store(store)
    listing[0].update(status="sent", sentWith={"chat": "project/chats/talk.chat", "message": "m1"})
    comments.write_store(store, listing)
    pending = _body(await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"}))["comments"]
    assert pending == []
    sent = _body(await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml", "status": "sent"}))["comments"]
    assert [comment["id"] for comment in sent] == [created["id"]]
    everything = _body(await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml", "status": "all"}))["comments"]
    assert len(everything) == 1
    for method, body in (("PATCH", json.dumps({"text": "Later"})), ("DELETE", None)):
        response = await jp_fetch(
            *ENDPOINT, created["id"], method=method, params={"path": "project/astra.yaml"}, body=body, raise_error=False
        )
        assert response.code == 409


@pytest.mark.parametrize("method, path, body, params", [
    ("POST", None, json.dumps({"comment": point()}), None),
    ("POST", None, json.dumps({"path": "project/astra.yaml"}), None),
    ("POST", None, json.dumps({"path": "project/astra.yaml", "comment": {"text": "x"}}), None),
    ("POST", None, json.dumps({"path": "project/notes.md", "comment": point()}), None),
    ("GET", None, None, {"path": "project/astra.yaml", "status": "draft"}),
    ("GET", None, None, {"path": "../astra.yaml"}),
    ("PATCH", "missing", json.dumps({}), {"path": "project/astra.yaml"}),
    ("POST", None, json.dumps({"path": "project/astra.yaml", "comment": point(text="\ud800")}), None),
])
async def test_bad_requests_are_rejected(jp_fetch, served, method, path, body, params):
    arguments = ENDPOINT + ((path,) if path else ())
    response = await jp_fetch(*arguments, method=method, body=body, params=params, raise_error=False)
    assert response.code == 400


@pytest.mark.parametrize("user, expected", [
    (User(username="researcher"), "researcher"),
    ({"username": "legacy"}, "legacy"),
    ({"name": "No username"}, ""),
    (None, ""),
])
def test_the_author_is_the_requesting_username(user, expected):
    handler = SimpleNamespace(current_user=user)
    assert comments.CommentAPIHandler.author.fget(handler) == expected


async def test_a_full_store_refuses_new_comments_but_stays_usable(jp_fetch, served, monkeypatch):
    first = await _create(jp_fetch, point())
    monkeypatch.setattr(comments, "MAX_STORE_BYTES", comments.store_path(served).stat().st_size)
    body = json.dumps({"path": "project/astra.yaml", "comment": point(text="Second")})
    response = await jp_fetch(*ENDPOINT, method="POST", body=body, raise_error=False)
    assert response.code == 413
    listing = _body(await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"}))["comments"]
    assert [comment["id"] for comment in listing] == [first["id"]]
    deleted = await jp_fetch(*ENDPOINT, first["id"], method="DELETE", params={"path": "project/astra.yaml"})
    assert deleted.code == 204


async def test_unknown_comments_are_not_found(jp_fetch, served):
    for method, body in (("PATCH", json.dumps({"text": "x"})), ("DELETE", None)):
        response = await jp_fetch(*ENDPOINT, "missing", method=method, body=body, params={"path": "project/astra.yaml"}, raise_error=False)
        assert response.code == 404


async def test_a_project_the_contents_manager_hides_is_refused(jp_fetch, served, jp_serverapp):
    hidden = Path(jp_serverapp.contents_manager.root_dir) / ".secret"
    hidden.mkdir()
    (hidden / "astra.yaml").write_text("name: hidden\n")
    response = await jp_fetch(*ENDPOINT, params={"path": ".secret/astra.yaml"}, raise_error=False)
    assert response.code in (403, 404)
    response = await jp_fetch(
        *ENDPOINT, method="POST", body=json.dumps({"path": ".secret/astra.yaml", "comment": point()}), raise_error=False
    )
    assert response.code in (403, 404)


async def test_requires_authentication(jp_fetch, served):
    response = await jp_fetch(
        *ENDPOINT, params={"path": "project/astra.yaml"}, follow_redirects=False, headers={"Authorization": ""}, raise_error=False
    )
    assert response.code in (302, 403)


async def test_writes_require_write_authorization(jp_fetch, served, jp_serverapp, monkeypatch):
    authorize = Mock(side_effect=lambda handler, user, action, resource: action == "read")
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", authorize)
    listing = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert listing.code == 200
    response = await jp_fetch(
        *ENDPOINT, method="POST", body=json.dumps({"path": "project/astra.yaml", "comment": point()}), raise_error=False
    )
    assert response.code == 403
    assert ("write", "contents") in {call.args[2:] for call in authorize.call_args_list}
    for method, body in (("PATCH", json.dumps({"text": "x"})), ("DELETE", None)):
        response = await jp_fetch(*ENDPOINT, "any", method=method, body=body, params={"path": "project/astra.yaml"}, raise_error=False)
        assert response.code == 403


# --- delivery in the message text --------------------------------------------


async def test_send_marks_comments_sent_and_returns_the_block(jp_fetch, served):
    first = await _create(jp_fetch, point())
    second = await _create(jp_fetch, selection(path="project/index.md"))
    body = {"path": "project/astra.yaml", "ids": [first["id"], "missing"], "chat": "project/chats/talk.chat"}
    response = await jp_fetch(*ENDPOINT, "send", method="POST", body=json.dumps(body))
    block = _body(response)["block"]
    assert block.startswith("Comments on this project (1):\n① outputs.hubble_diagram")
    assert "results/baseline/hubble_diagram.png" in block
    stored_comments = {comment["id"]: comment for comment in comments.read_store(comments.store_path(served))}
    assert stored_comments[first["id"]]["status"] == "sent"
    assert stored_comments[first["id"]]["sentWith"] == {"chat": "project/chats/talk.chat", "message": None}
    assert stored_comments[second["id"]]["status"] == "pending"
    again = await jp_fetch(*ENDPOINT, "send", method="POST", body=json.dumps(body))
    assert _body(again)["block"] is None


@pytest.mark.parametrize("body", [
    {"ids": ["x"], "chat": "c.chat"},
    {"path": "project/astra.yaml", "ids": [], "chat": "c.chat"},
    {"path": "project/astra.yaml", "ids": "x", "chat": "c.chat"},
    {"path": "project/astra.yaml", "ids": [1], "chat": "c.chat"},
    {"path": "project/astra.yaml", "ids": ["x"]},
    {"path": "project/astra.yaml", "ids": ["x"], "chat": ""},
    {"path": "project/astra.yaml", "ids": ["x"] * (comments.MAX_SEND_IDS + 1), "chat": "c.chat"},
])
async def test_bad_send_requests_are_rejected(jp_fetch, served, body):
    response = await jp_fetch(*ENDPOINT, "send", method="POST", body=json.dumps(body), raise_error=False)
    assert response.code == 400


async def test_send_requires_write_authorization(jp_fetch, served, jp_serverapp, monkeypatch):
    authorize = Mock(side_effect=lambda handler, user, action, resource: action == "read")
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", authorize)
    body = {"path": "project/astra.yaml", "ids": ["x"], "chat": "c.chat"}
    response = await jp_fetch(*ENDPOINT, "send", method="POST", body=json.dumps(body), raise_error=False)
    assert response.code == 403


def test_a_comment_sent_before_its_message_existed_is_stored(tmp_path):
    path = tmp_path / "comments.json"
    comment = stored(point(), status="sent", sentWith={"chat": "c.chat", "message": None})
    comments.write_store(path, [comment])
    assert comments.read_store(path)[0]["sentWith"] == {"chat": "c.chat", "message": None}


def test_a_comment_on_a_session_message_names_the_session_and_quotes_it():
    draft = selection(text="Why this prior?", path="project/chats/fit.chat", startLine=None, endLine=None, startCol=None, endCol=None, quote="a flat prior on Omega_m")
    draft["target"].update(kind="message", message="m-1", version={"commit": None, "key": None, "hash": None, "label": None})
    comment = stored(draft)
    assert comments.describe_comment(comment, "project", None) == (
        'session chats/fit.chat, quoting "a flat prior on Omega_m" — "Why this prior?"'
    )
