"""Sessions are listed through the contents manager, with readable titles and message counts."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyterlab_chat.models import Message
import pytest
from tornado import web

from jupyterlab_lightcone import sessions

ENDPOINT = ("jupyterlab_lightcone", "api", "chat-sessions")
USER = "76192c59327544d7b160694eacfa5309"
SYSTEM = "hidden::jupyter_ai_system"
CODEX = "jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona"
CLAUDE = "jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona"
USERS = {
    USER: {"username": USER, "name": "Anonymous Megaclite", "display_name": "Anonymous Megaclite", "bot": False},
    SYSTEM: {"username": SYSTEM, "name": "System", "display_name": "System", "bot": True},
    CODEX: {"username": CODEX, "name": "Codex", "display_name": "Codex", "bot": True},
}


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return "/user/researcher/"


def message(body, sender=USER, time=1.0, **extra):
    return {"id": f"{sender}-{time}", "body": body, "time": time, "sender": sender, "type": "msg", **extra}


def chat(*messages, users=USERS, metadata=None):
    return {"messages": list(messages), "users": dict(users), "attachments": {}, "metadata": metadata or {}}


def write_chat(path: Path, document, modified: float | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(document if isinstance(document, str) else json.dumps(document))
    if modified is not None:
        os.utime(path, (modified, modified))
    return path


def manager_for(root: Path, **options) -> FileContentsManager:
    """The contents manager the listing reads through, serving `root` on the server's default terms."""
    return FileContentsManager(root_dir=str(root), **options)


@pytest.fixture
def project(jp_root_dir):
    directory = jp_root_dir / "project"
    (directory / "chats").mkdir(parents=True)
    (directory / "astra.yaml").write_text("name: example\n")
    return directory


# --- titles, agents and counts, from the document ---------------------------------


def test_the_title_is_the_first_line_a_person_wrote():
    document = chat(
        message("", sender=CODEX, time=1.0),
        message("Refreshed all AI personas in this chat.", sender=SYSTEM, time=1.5),
        message("\n  Build a Hubble diagram\nfrom Union 2.1 data", time=2.0),
        message("use the lightcone skill", time=3.0),
    )
    assert sessions.session_title(document, "untitled") == "Build a Hubble diagram"


def test_a_long_first_line_is_trimmed_to_eighty_characters():
    line = "word " * 30
    title = sessions.session_title(chat(message(line)), "untitled")
    assert len(title) == 80
    assert title.endswith("…")
    assert title.startswith("word word")
    assert not title[:-1].endswith(" ")


@pytest.mark.parametrize("document", [
    None,
    chat(),
    chat(message("", sender=CODEX), message("only the agent spoke", sender=CODEX)),
    chat(message("deleted", deleted=True)),
    chat(message("   \n\n")),
    {"messages": "not a list"},
])
@pytest.mark.parametrize("stem, expected", [
    ("untitled", "untitled"),
    ("untitled3", "untitled3"),
    ("hubble-diagram_with-error_bars", "hubble diagram with error bars"),
])
def test_without_a_person_message_the_stem_names_the_session(document, stem, expected):
    assert sessions.session_title(document, stem) == expected


def test_the_last_agent_is_named_from_the_users_map_or_its_id():
    document = chat(message("hi"), message("hello", sender=CLAUDE), message("bye", sender=CODEX, time=2.0))
    assert sessions.last_agent(document) == "Codex"
    unnamed = chat(message("hi"), message("hello", sender=CLAUDE, time=2.0))
    assert sessions.last_agent(unnamed) == "ClaudeAcpPersona"
    assert sessions.last_agent(chat(message("hi"))) is None
    assert sessions.last_agent(None) is None


def test_a_persona_whose_name_is_its_id_is_named_by_its_last_segment():
    """Jupyter Chat's model fills an empty display name from the username; that is no name."""
    users = {**USERS, CLAUDE: {"username": CLAUDE, "name": "", "display_name": "", "bot": True}}
    document = chat(message("hi"), message("hello", sender=CLAUDE, time=2.0), users=users)
    assert sessions.last_agent(document) == "ClaudeAcpPersona"


def test_messages_are_counted_without_deleted_ones():
    document = chat(message("a"), message("b", sender=CODEX, time=2.0), message("", time=3.0, deleted=True), "junk")
    assert sessions.message_count(document) == 2
    assert sessions.message_count(None) == 0


def test_entries_that_do_not_fit_jupyter_chats_model_are_skipped_one_by_one():
    """A hand-edited or half-written chat degrades per entry rather than becoming unreadable."""
    without_id = {"body": "no id", "time": 1.5, "sender": USER, "type": "msg"}
    unknown_field = message("unknown field", time=1.7, stacked=True)
    not_text = message(42, time=1.8)
    document = chat(message("A question"), without_id, unknown_field, not_text, message("Reply", sender=CODEX, time=2.0))
    assert sessions.message_count(document) == 2
    assert sessions.session_title(document, "untitled") == "A question"
    users = {**USERS, CODEX: "not a user", CLAUDE: {"display_name": "No username"}}
    assert sessions.last_agent(chat(message("hi"), message("bye", sender=CODEX, time=2.0), users=users)) == "CodexAcpPersona"


# --- the documents, through the contents manager -----------------------------------


def test_broken_chats_are_not_parsed():
    assert sessions.parse_chat(json.dumps(chat(message("a title"))))["messages"][0]["body"] == "a title"
    assert sessions.parse_chat("{not json") is None
    assert sessions.parse_chat("[1, 2]") is None
    # Nesting deep enough to exhaust the parser's recursion limit, well within the size cap.
    assert sessions.parse_chat("[" * 200_000) is None


async def test_oversized_and_removed_chats_are_read_as_the_manager_reports_them(tmp_path, monkeypatch):
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / "big.chat", chat(message("a title")))
    manager = manager_for(root)
    [model] = await sessions.chat_models(manager, "project/chats")
    assert (await sessions.read_chat(manager, model))["messages"][0]["body"] == "a title"
    monkeypatch.setattr(sessions, "MAX_CHAT_BYTES", 16)
    assert await sessions.read_chat(manager, model) is None
    assert await sessions.read_chat(manager, {**model, "size": None}) is None
    monkeypatch.undo()
    (root / "project" / "chats" / "big.chat").unlink()
    with pytest.raises(web.HTTPError) as raised:
        await sessions.read_chat(manager, model)
    assert raised.value.status_code == 404


async def test_only_chat_files_directly_inside_a_folder_are_chats(tmp_path):
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / "talk.chat", chat(message("Hello")))
    (root / "project" / "chats" / "folder.chat").mkdir()
    (root / "project" / "chats" / "notes.txt").write_text("not a chat")
    manager = manager_for(root)
    assert [model["path"] for model in await sessions.chat_models(manager, "project/chats")] == ["project/chats/talk.chat"]
    assert await sessions.chat_models(manager, "project/missing") == []
    # A file where the folder should be holds no sessions either.
    assert await sessions.chat_models(manager, "project/chats/talk.chat") == []


async def test_a_malformed_chat_never_hides_the_others(tmp_path):
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / "talk.chat", chat(message("A real question")), 1_000)
    write_chat(root / "project" / "chats" / "deep.chat", "[" * 200_000, 2_000)
    listing = await sessions.list_sessions(manager_for(root), "project")
    # The unreadable chat is still listed under its name.
    assert [(session["path"], session["title"], session["messages"]) for session in listing] == [
        ("project/chats/deep.chat", "deep", 0),
        ("project/chats/talk.chat", "A real question", 1),
    ]


def test_modified_is_the_managers_time_with_milliseconds():
    model = {"last_modified": datetime(1970, 1, 1, 0, 50, tzinfo=timezone.utc)}
    assert sessions.modified_time(model) == "1970-01-01T00:50:00.000+00:00"


async def test_sessions_are_listed_newest_first_from_chats_and_the_project_root(tmp_path):
    root = tmp_path / "root"
    project = root / "project"
    project.mkdir(parents=True)
    write_chat(
        project / "chats" / "older.chat",
        chat(message("An older question"), message("Reply", sender=CODEX, time=2.0), metadata={"id": "older-id"}),
        1_000,
    )
    write_chat(project / "chats" / "newer.chat", chat(message("The newest question")), 3_000)
    write_chat(project / "untitled1.chat", chat(message("", sender=CODEX)), 2_000)
    write_chat(project / "chats" / ".hidden.chat", chat(message("hidden")), 4_000)
    (project / "chats" / "folder.chat").mkdir()
    (project / "chats" / "notes.txt").write_text("not a chat")
    (project / "chats" / ".ipynb_checkpoints").mkdir()
    write_chat(project / "chats" / ".ipynb_checkpoints" / "newer-checkpoint.chat", chat(message("checkpoint")), 5_000)

    listing = await sessions.list_sessions(manager_for(root), "project")

    assert [session["path"] for session in listing] == [
        "project/chats/newer.chat",
        "project/untitled1.chat",
        "project/chats/older.chat",
    ]
    newer, untitled, older = listing
    assert newer == {
        "path": "project/chats/newer.chat",
        "title": "The newest question",
        "modified": "1970-01-01T00:50:00.000+00:00",
        "messages": 1,
        "lastAgent": None,
    }
    assert untitled["title"] == "untitled1"
    assert untitled["lastAgent"] == "Codex"
    assert older["messages"] == 2


async def test_hidden_chats_follow_the_managers_rule(tmp_path):
    """The file browser decides what is hidden; the listing shows exactly what it shows."""
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / ".draft.chat", chat(message("hidden")))
    write_chat(root / "project" / "chats" / "talk.chat", chat(message("shown")))
    hidden = [session["path"] for session in await sessions.list_sessions(manager_for(root), "project")]
    assert hidden == ["project/chats/talk.chat"]
    shown = await sessions.list_sessions(manager_for(root, allow_hidden=True), "project")
    assert sorted(session["path"] for session in shown) == ["project/chats/.draft.chat", "project/chats/talk.chat"]


async def test_a_project_without_chats_lists_nothing(tmp_path):
    assert await sessions.list_sessions(manager_for(tmp_path), "") == []
    assert sessions.chats_directory("") == "chats"
    assert sessions.chats_directory("a/b") == "a/b/chats"


# --- the listing route -------------------------------------------------------------


async def test_the_listing_endpoint_reports_messages(jp_fetch, jp_serverapp, project):
    write_chat(project / "chats" / "talk.chat", chat(message("Hello"), metadata={"id": "talk-id"}))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    assert [session["title"] for session in body["sessions"]] == ["Hello"]


async def test_a_malformed_chat_does_not_break_the_listing_endpoint(jp_fetch, project):
    write_chat(project / "chats" / "talk.chat", chat(message("Hello")), 1_000)
    write_chat(project / "chats" / "deep.chat", "[" * 200_000, 2_000)
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    assert [session["title"] for session in body["sessions"]] == ["deep", "Hello"]


async def test_a_project_reached_through_a_symlink_keeps_its_contents_paths(jp_fetch, jp_serverapp, jp_root_dir):
    real = jp_root_dir / "real" / "project"
    write_chat(real / "chats" / "talk.chat", chat(message("Through the link"), metadata={"id": "talk-id"}))
    (real / "astra.yaml").write_text("name: linked\n")
    (jp_root_dir / "link").symlink_to(real, target_is_directory=True)
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "link/astra.yaml"})).body)
    assert body["directory"] == "link/chats"
    assert [session["path"] for session in body["sessions"]] == ["link/chats/talk.chat"]


async def test_a_symlinked_entrypoint_lists_the_chats_beside_the_link(jp_fetch, jp_root_dir):
    shared = jp_root_dir / "shared"
    write_chat(shared / "chats" / "elsewhere.chat", chat(message("Beside the target")))
    (shared / "astra.yaml").write_text("name: shared\n")
    project = jp_root_dir / "project"
    project.mkdir()
    (project / "astra.yaml").symlink_to(shared / "astra.yaml")
    write_chat(project / "chats" / "talk.chat", chat(message("Beside the link")))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    # The chats the browser creates in the reported folder, never the target's.
    assert body["directory"] == "project/chats"
    assert [(session["path"], session["title"]) for session in body["sessions"]] == [("project/chats/talk.chat", "Beside the link")]


async def test_a_project_at_the_server_root(jp_fetch, jp_root_dir):
    (jp_root_dir / "astra.yaml").write_text("name: root\n")
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).body)
    assert body == {"directory": "chats", "sessions": []}
    write_chat(jp_root_dir / "chats" / "talk.chat", chat(message("At the root")))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).body)
    assert [(session["path"], session["title"]) for session in body["sessions"]] == [("chats/talk.chat", "At the root")]


@pytest.mark.parametrize("path, status", [
    ("../outside/astra.yaml", 400),
    ("/project/astra.yaml", 400),
    ("project/notes.yaml", 400),
    ("missing/astra.yaml", 404),
    (".hidden/astra.yaml", 404),
    ("escape/astra.yaml", 403),
])
async def test_the_listing_rejects_paths_the_server_does_not_serve(jp_fetch, jp_root_dir, tmp_path, path, status):
    (jp_root_dir / ".hidden").mkdir()
    (jp_root_dir / ".hidden" / "astra.yaml").write_text("name: private\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "astra.yaml").write_text("name: outside\n")
    (jp_root_dir / "escape").symlink_to(outside, target_is_directory=True)
    response = await jp_fetch(*ENDPOINT, params={"path": path}, raise_error=False)
    assert response.code == status


async def test_listing_requires_contents_authorization(jp_fetch, jp_serverapp, project, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args, **kwargs: False)
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"}, raise_error=False)
    assert response.code == 403


async def test_requires_authentication(jp_fetch, project):
    response = await jp_fetch(
        *ENDPOINT, params={"path": "project/astra.yaml"}, follow_redirects=False, headers={"Authorization": ""},
        raise_error=False,
    )
    assert response.code in (302, 403)
