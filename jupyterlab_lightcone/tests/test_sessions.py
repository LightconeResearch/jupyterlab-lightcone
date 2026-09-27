"""Sessions are listed through the contents manager, with readable titles, message counts and live activity, and chats name their project."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from jupyter_server.services.contents.filemanager import FileContentsManager
from jupyterlab_chat.models import Message
import pytest
from tornado import web

from jupyterlab_lightcone import sessions
from jupyterlab_lightcone.agent_activity import PROCESSING_PERSONAS, record_persona_state

ENDPOINT = ("jupyterlab_lightcone", "api", "chat-sessions")
PROJECT_ENDPOINT = ("jupyterlab_lightcone", "api", "chat-project")
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


def working(settings: dict, chat_id: str, persona: str = CODEX) -> None:
    """Record, as Jupyter AI's own event would, that a persona is processing a message in a chat."""
    record_persona_state(settings, {"chat_id": chat_id, "persona_id": persona, "processing": True})


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
    assert sessions.summarize_chat(document).title == "Build a Hubble diagram"


def test_a_long_first_line_is_trimmed_to_eighty_characters():
    line = "word " * 30
    title = sessions.summarize_chat(chat(message(line))).title
    assert len(title) == 80
    assert title.endswith("…")
    assert title.startswith("word word")
    assert not title[:-1].endswith(" ")


@pytest.mark.parametrize("document", [
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
    assert sessions.summarize_chat(document).title is None
    listed = sessions.describe_session(
        {"path": f"p/chats/{stem}.chat", "name": f"{stem}.chat", "last_modified": datetime(1970, 1, 1, tzinfo=timezone.utc)},
        sessions.summarize_chat(document),
        set(),
    )
    assert listed["title"] == expected


def test_the_last_agent_is_named_from_the_users_map_or_its_id():
    document = chat(message("hi"), message("hello", sender=CLAUDE), message("bye", sender=CODEX, time=2.0))
    assert sessions.summarize_chat(document).last_agent == "Codex"
    unnamed = chat(message("hi"), message("hello", sender=CLAUDE, time=2.0))
    assert sessions.summarize_chat(unnamed).last_agent == "ClaudeAcpPersona"
    assert sessions.summarize_chat(chat(message("hi"))).last_agent is None


def test_a_persona_whose_name_is_its_id_is_named_by_its_last_segment():
    """Jupyter Chat's model fills an empty display name from the username; that is no name."""
    users = {**USERS, CLAUDE: {"username": CLAUDE, "name": "", "display_name": "", "bot": True}}
    document = chat(message("hi"), message("hello", sender=CLAUDE, time=2.0), users=users)
    assert sessions.summarize_chat(document).last_agent == "ClaudeAcpPersona"


def test_messages_are_counted_without_deleted_ones():
    document = chat(message("a"), message("b", sender=CODEX, time=2.0), message("", time=3.0, deleted=True), "junk")
    assert sessions.summarize_chat(document).messages == 2
    assert sessions.summarize_chat({"messages": "not a list"}).messages == 0


def test_an_unreadable_chat_has_no_known_count_title_or_agent():
    """Too large or not a chat: listed by name, its count unknown rather than zero."""
    assert sessions.summarize_chat(None) == sessions.ChatSummary(title=None, messages=None, last_agent=None)


def test_entries_that_do_not_fit_jupyter_chats_model_are_skipped_one_by_one():
    """A hand-edited or half-written chat degrades per entry rather than becoming unreadable."""
    without_id = {"body": "no id", "time": 1.5, "sender": USER, "type": "msg"}
    unknown_field = message("unknown field", time=1.7, stacked=True)
    not_text = message(42, time=1.8)
    document = chat(message("A question"), without_id, unknown_field, not_text, message("Reply", sender=CODEX, time=2.0))
    summary = sessions.summarize_chat(document)
    assert summary.messages == 2
    assert summary.title == "A question"
    users = {**USERS, CODEX: "not a user", CLAUDE: {"display_name": "No username"}}
    replied = chat(message("hi"), message("bye", sender=CODEX, time=2.0), users=users)
    assert sessions.summarize_chat(replied).last_agent == "CodexAcpPersona"


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
    listing = await sessions.list_sessions(manager_for(root), "project", sessions.ChatSummaries(), set())
    # The unreadable chat is still listed under its name.
    assert [(session["path"], session["title"], session["messages"]) for session in listing] == [
        ("project/chats/deep.chat", "deep", None),
        ("project/chats/talk.chat", "A real question", 1),
    ]


async def test_summaries_are_read_again_only_when_the_file_changes(tmp_path, monkeypatch):
    root = tmp_path / "root"
    talk = write_chat(root / "project" / "chats" / "talk.chat", chat(message("First")), 1_000)
    manager = manager_for(root)
    summaries = sessions.ChatSummaries(capacity=1)
    reads = []
    read_chat = sessions.read_chat

    async def counted(manager, model):
        reads.append(model["path"])
        return await read_chat(manager, model)

    monkeypatch.setattr(sessions, "read_chat", counted)
    listed = await sessions.list_sessions(manager, "project", summaries, set())
    assert await sessions.list_sessions(manager, "project", summaries, set()) == listed
    assert reads == ["project/chats/talk.chat"]

    write_chat(talk, chat(message("Second")), 2_000)
    [session] = await sessions.list_sessions(manager, "project", summaries, set())
    assert session["title"] == "Second"
    assert len(reads) == 2

    # Beyond its capacity, the least recently listed summary is dropped.
    write_chat(root / "other" / "chats" / "note.chat", chat(message("Other")))
    await sessions.list_sessions(manager, "other", summaries, set())
    await sessions.list_sessions(manager, "project", summaries, set())
    assert reads[-1] == "project/chats/talk.chat"
    assert len(reads) == 4


async def test_live_activity_changes_without_rereading_an_unchanged_chat(tmp_path, monkeypatch):
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / "talk.chat", chat(message("Hello"), metadata={"id": "talk-id"}))
    manager = manager_for(root)
    summaries = sessions.ChatSummaries()
    [idle] = await sessions.list_sessions(manager, "project", summaries, set())
    assert idle["activity"] == "idle"

    async def unexpected_read(manager, model):
        raise AssertionError("An unchanged chat should reuse its summary")

    monkeypatch.setattr(sessions, "read_chat", unexpected_read)
    [active] = await sessions.list_sessions(manager, "project", summaries, {"talk-id"})
    assert active["activity"] == "working"
    [idle_again] = await sessions.list_sessions(manager, "project", summaries, set())
    assert idle_again["activity"] == "idle"


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

    listing = await sessions.list_sessions(manager_for(root), "project", sessions.ChatSummaries(), {"older-id"})

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
        "activity": "idle",
    }
    assert untitled["title"] == "untitled1"
    assert untitled["lastAgent"] == "Codex"
    assert older["messages"] == 2
    assert older["activity"] == "working"


async def test_hidden_chats_follow_the_managers_rule(tmp_path):
    """The file browser decides what is hidden; the listing shows exactly what it shows."""
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / ".draft.chat", chat(message("hidden")))
    write_chat(root / "project" / "chats" / "talk.chat", chat(message("shown")))
    hidden = [session["path"] for session in await sessions.list_sessions(manager_for(root), "project", sessions.ChatSummaries(), set())]
    assert hidden == ["project/chats/talk.chat"]
    shown = await sessions.list_sessions(manager_for(root, allow_hidden=True), "project", sessions.ChatSummaries(), set())
    assert sorted(session["path"] for session in shown) == ["project/chats/.draft.chat", "project/chats/talk.chat"]


async def test_a_project_without_chats_lists_nothing(tmp_path):
    assert await sessions.list_sessions(manager_for(tmp_path), "", sessions.ChatSummaries(), set()) == []
    assert sessions.chats_directory("") == "chats"
    assert sessions.chats_directory("a/b") == "a/b/chats"


# --- activity ------------------------------------------------------------------


def test_activity_is_working_while_a_persona_processes_a_message_in_the_chat():
    document = chat(message("hi"), metadata={"id": "chat-1"})
    assert sessions.activity_state(sessions.summarize_chat(document), {"chat-1"}) == "working"
    assert sessions.activity_state(sessions.summarize_chat(document), {"other"}) == "idle"
    assert sessions.activity_state(sessions.summarize_chat(document), set()) == "idle"
    # A chat without the id Jupyter Chat gives it, or no document at all, is never working.
    assert sessions.activity_state(sessions.summarize_chat(chat(message("hi"))), {"chat-1"}) == "idle"
    assert sessions.activity_state(sessions.summarize_chat(None), {"chat-1"}) == "idle"
    assert sessions.chat_id({"metadata": {"id": 5}}) is None
    assert sessions.chat_id({"metadata": "no map"}) is None


# --- the listing route -------------------------------------------------------------


async def test_the_listing_endpoint_reports_sessions_and_their_activity(jp_fetch, jp_serverapp, project):
    write_chat(
        project / "chats" / "talk.chat",
        chat(message("Fit the cosmology"), message("Done", sender=CODEX, time=2.0), metadata={"id": "talk-id"}),
        2_000,
    )
    write_chat(project / "chats" / "quiet.chat", chat(message("Quiet one"), metadata={"id": "quiet-id"}), 1_000)
    # Seeded as the persona events are recorded, so writer and reader must agree.
    working(jp_serverapp.web_app.settings, "talk-id")
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert response.code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = json.loads(response.body)
    assert [(session["title"], session["activity"], session["lastAgent"]) for session in body["sessions"]] == [
        ("Fit the cosmology", "working", "Codex"),
        ("Quiet one", "idle", None),
    ]


async def test_the_listing_endpoint_works_before_any_persona_reported(jp_fetch, jp_serverapp, project):
    jp_serverapp.web_app.settings.pop(PROCESSING_PERSONAS, None)
    write_chat(project / "chats" / "talk.chat", chat(message("Hello"), metadata={"id": "talk-id"}))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    assert [session["activity"] for session in body["sessions"]] == ["idle"]


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
    working(jp_serverapp.web_app.settings, "talk-id")
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "link/astra.yaml"})).body)
    assert [(session["path"], session["activity"]) for session in body["sessions"]] == [("link/chats/talk.chat", "working")]


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
    assert [(session["path"], session["title"]) for session in body["sessions"]] == [("project/chats/talk.chat", "Beside the link")]


async def test_a_project_at_the_server_root(jp_fetch, jp_root_dir):
    (jp_root_dir / "astra.yaml").write_text("name: root\n")
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).body)
    assert body == {"sessions": []}
    write_chat(jp_root_dir / "chats" / "talk.chat", chat(message("At the root")))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).body)
    assert [(session["path"], session["title"]) for session in body["sessions"]] == [("chats/talk.chat", "At the root")]


# --- the chat's project -------------------------------------------------------------


async def chat_project_of(jp_fetch, path):
    return json.loads((await jp_fetch(*PROJECT_ENDPOINT, params={"path": path})).body)["entrypoint"]


async def test_a_chat_stored_in_a_project_belongs_to_it(jp_fetch, jp_root_dir, project):
    write_chat(project / "chats" / "talk.chat", chat(message("Hi"), metadata={sessions.CHAT_PROJECT: "other/astra.yaml"}))
    write_chat(project / "beside.chat", chat())
    assert await chat_project_of(jp_fetch, "project/chats/talk.chat") == "project/astra.yaml"
    assert await chat_project_of(jp_fetch, "project/beside.chat") == "project/astra.yaml"


async def test_a_chat_outside_every_project_belongs_to_the_one_it_recorded(jp_fetch, jp_root_dir, project):
    (jp_root_dir / "other").mkdir()
    (jp_root_dir / "other" / "astra.yaml").write_text("name: other\n")
    write_chat(jp_root_dir / "loose" / "recorded.chat", chat(metadata={sessions.CHAT_PROJECT: "other/astra.yaml"}))
    write_chat(jp_root_dir / "loose" / "gone.chat", chat(metadata={sessions.CHAT_PROJECT: "removed/astra.yaml"}))
    write_chat(jp_root_dir / "loose" / "escaping.chat", chat(metadata={sessions.CHAT_PROJECT: "../x/astra.yaml"}))
    write_chat(jp_root_dir / "loose" / "fresh.chat", chat())
    write_chat(jp_root_dir / "loose" / "broken.chat", "{not json")
    assert await chat_project_of(jp_fetch, "loose/recorded.chat") == "other/astra.yaml"
    for name in ("gone", "escaping", "fresh", "broken"):
        assert await chat_project_of(jp_fetch, f"loose/{name}.chat") is None


@pytest.mark.parametrize("path, status", [
    ("missing/talk.chat", 404),
    (".hidden/talk.chat", 404),
    ("project", 400),
])
async def test_the_chat_project_follows_the_managers_rules(jp_fetch, jp_root_dir, project, path, status):
    write_chat(jp_root_dir / ".hidden" / "talk.chat", chat())
    response = await jp_fetch(*PROJECT_ENDPOINT, params={"path": path}, raise_error=False)
    assert response.code == status


async def test_the_chat_project_requires_contents_authorization(jp_fetch, jp_serverapp, project, monkeypatch):
    write_chat(project / "chats" / "talk.chat", chat())
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args, **kwargs: False)
    response = await jp_fetch(*PROJECT_ENDPOINT, params={"path": "project/chats/talk.chat"}, raise_error=False)
    assert response.code == 403


# --- request validation -------------------------------------------------------------


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


@pytest.mark.parametrize("endpoint, path", [(ENDPOINT, "project/astra.yaml"), (PROJECT_ENDPOINT, "project/chats/talk.chat")])
async def test_requires_authentication(jp_fetch, project, endpoint, path):
    write_chat(project / "chats" / "talk.chat", chat())
    response = await jp_fetch(
        *endpoint, params={"path": path}, follow_redirects=False, headers={"Authorization": ""},
        raise_error=False,
    )
    assert response.code in (302, 403)


# --- full-text search ----------------------------------------------------------

SEARCH = (*ENDPOINT, "search")


async def test_search_finds_messages_case_insensitively_newest_first(tmp_path):
    root = tmp_path / "root"
    project = root / "project"
    write_chat(project / "chats" / "fit.chat", chat(
        message("Plot the Hubble residuals", time=10.0),
        message("I plotted the HUBBLE residuals versus redshift.", sender=CODEX, time=20.0),
        message("Something else entirely", time=30.0),
    ))
    write_chat(project / "old.chat", chat(message("An older hubble question", time=5.0)))
    matches = await sessions.search_sessions(manager_for(root), "project", "hubble")
    assert [(match["path"], match["time"][:19]) for match in matches] == [
        ("project/chats/fit.chat", "1970-01-01T00:00:20"),
        ("project/chats/fit.chat", "1970-01-01T00:00:10"),
        ("project/old.chat", "1970-01-01T00:00:05"),
    ]
    agent_reply = matches[0]
    assert agent_reply["title"] == "Plot the Hubble residuals"
    assert agent_reply["author"] == "Codex" and agent_reply["agent"] is True
    assert agent_reply["message"] == f"{CODEX}-20.0"
    assert agent_reply["snippet"] == "I plotted the HUBBLE residuals versus redshift."
    assert matches[1]["author"] == "Anonymous Megaclite" and matches[1]["agent"] is False


async def test_search_snippets_are_cut_around_the_match_and_matches_are_bounded(tmp_path, monkeypatch):
    root = tmp_path / "root"
    body = "a " * 100 + "needle" + "\n b" * 100
    write_chat(root / "project" / "chats" / "long.chat", chat(*(message(body, time=float(i)) for i in range(5))))
    monkeypatch.setattr(sessions, "MAX_SEARCH_MATCHES", 3)
    manager = manager_for(root)
    matches = await sessions.search_sessions(manager, "project", "needle")
    assert len(matches) == 3
    text = matches[0]["snippet"]
    assert text.startswith("…") and text.endswith("…") and "needle" in text and "\n" not in text
    # A query is literal text, never a pattern.
    assert await sessions.search_sessions(manager, "project", "a.*needle") == []


@pytest.mark.parametrize("time, expected", [
    (10.5, "1970-01-01T00:00:10.500+00:00"),
    ("10", None),
    (True, None),
    (10**15, None),
    (10**20, None),
])
def test_a_message_time_is_iso_8601_or_none_when_no_date_can_hold_it(time, expected):
    """The model does not check the field's type: a time no date can hold sorts last rather than failing."""
    assert sessions.message_time(Message(id="m", body="when", time=time, sender=USER)) == expected


async def test_the_search_endpoint(jp_fetch, project):
    write_chat(project / "chats" / "fit.chat", chat(message("Fit the contour levels", time=1.0)))
    response = await jp_fetch(*SEARCH, params={"path": "project/astra.yaml", "q": "contour"})
    matches = json.loads(response.body)["matches"]
    assert [match["path"] for match in matches] == ["project/chats/fit.chat"]
    for query in ("x", "x" * 201):
        refused = await jp_fetch(*SEARCH, params={"path": "project/astra.yaml", "q": query}, raise_error=False)
        assert refused.code == 400


async def test_searching_requires_contents_authorization(jp_fetch, jp_serverapp, project, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args, **kwargs: False)
    response = await jp_fetch(*SEARCH, params={"path": "project/astra.yaml", "q": "fit"}, raise_error=False)
    assert response.code == 403


async def test_search_skips_unreadable_removed_and_malformed_entries(tmp_path, monkeypatch):
    root = tmp_path / "root"
    project = root / "project"
    write_chat(project / "chats" / "good.chat", chat(
        {"body": "needle without id", "time": 1.0, "sender": USER},
        message("The needle question", time=2.0),
        message("needle deleted", deleted=True, time=3.0),
    ))
    write_chat(project / "chats" / "broken.chat", "{needle")
    write_chat(project / "chats" / "large.chat", chat(message("needle " * 3000)))
    write_chat(project / "chats" / ".hidden.chat", chat(message("needle hidden")))
    removed = write_chat(project / "chats" / "removed.chat", chat(message("needle removed")))
    monkeypatch.setattr(sessions, "MAX_CHAT_BYTES", 2000)
    read_chat = sessions.read_chat

    async def disappearing(manager, model):
        if model["name"] == removed.name:
            removed.unlink()
        return await read_chat(manager, model)

    monkeypatch.setattr(sessions, "read_chat", disappearing)
    matches = await sessions.search_sessions(manager_for(root), "project", "needle")
    assert [(match["path"], match["title"], match["snippet"]) for match in matches] == [
        ("project/chats/good.chat", "The needle question", "The needle question")
    ]


async def test_search_without_a_human_message_uses_the_same_filename_title_as_listings(tmp_path):
    root = tmp_path / "root"
    write_chat(root / "project" / "chats" / "agent-only.chat", chat(message("A needle", sender=CODEX)))
    [match] = await sessions.search_sessions(manager_for(root), "project", "needle")
    assert match["title"] == "agent only"
