"""Sessions are listed with readable titles and live activity; preparing a project keeps chats out of Git."""

import json
import logging
import os
from pathlib import Path
import subprocess
import warnings

from jupyter_server.base.handlers import log as server_log
from jupyter_server.utils import JupyterServerAuthWarning
import pytest

from jupyterlab_lightcone import sessions
from jupyterlab_lightcone.sessions import SESSION_ACTIVITY, setup_session_handlers

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


@pytest.fixture(autouse=True)
def no_outer_repository(tmp_path, monkeypatch):
    """A temporary project must never be seen as part of a repository above the test root.

    The ceiling is the test root's parent: Git still looks above a ceiling that
    is the very folder it starts in, and some tests start in `tmp_path` itself.
    """
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))


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


@pytest.fixture
def project(jp_root_dir):
    directory = jp_root_dir / "project"
    (directory / "chats").mkdir(parents=True)
    (directory / "astra.yaml").write_text("name: example\n")
    return directory


def git(directory: Path, *arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=directory, capture_output=True, text=True, check=True).stdout.strip()


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


def test_messages_are_counted_without_deleted_ones():
    document = chat(message("a"), message("b", sender=CODEX, time=2.0), message("", time=3.0, deleted=True), "junk")
    assert sessions.message_count(document) == 2
    assert sessions.message_count(None) == 0


@pytest.mark.parametrize("entry, expected", [
    ({"state": "working", "persona": CODEX, "since": "2026-09-23T00:00:00+00:00"}, "working"),
    ({"state": "idle", "persona": CODEX, "since": "2026-09-23T00:00:00+00:00"}, "idle"),
    ({"state": "done"}, "idle"),
    (None, "idle"),
])
def test_activity_is_working_only_while_the_persona_manager_says_so(entry, expected):
    activity = {} if entry is None else {"project/chats/talk.chat": entry}
    assert sessions.activity_state(activity, "project/chats/talk.chat") == expected
    assert sessions.activity_state(activity, "project/chats/other.chat") == "idle"


def test_oversized_and_broken_chats_are_not_parsed(tmp_path, monkeypatch):
    path = write_chat(tmp_path / "big.chat", chat(message("a title")))
    assert sessions.read_chat(path)["messages"][0]["body"] == "a title"
    monkeypatch.setattr(sessions, "MAX_CHAT_BYTES", 16)
    assert sessions.read_chat(path) is None
    monkeypatch.setattr(sessions, "MAX_CHAT_BYTES", 2 * 1024 * 1024)
    assert sessions.read_chat(write_chat(tmp_path / "broken.chat", "{not json")) is None
    assert sessions.read_chat(write_chat(tmp_path / "list.chat", "[1, 2]")) is None
    assert sessions.read_chat(tmp_path / "missing.chat") is None
    # Nesting deep enough to exhaust the parser's recursion limit, well within the size cap.
    assert sessions.read_chat(write_chat(tmp_path / "deep.chat", "[" * 200_000)) is None


def test_a_malformed_chat_never_hides_the_others(tmp_path, monkeypatch):
    project = tmp_path / "project"
    write_chat(project / "chats" / "talk.chat", chat(message("A real question")), 1_000)
    write_chat(project / "chats" / "deep.chat", "[" * 200_000, 2_000)
    write_chat(project / "chats" / "future.chat", chat(message("From year 31 million")))
    write_chat(project / "chats" / "beyond.chat", chat(message("Past time_t")))
    # ext4 and others clamp such times on write, so the stat reports them instead:
    # datetime rejects the first with ValueError and the second with OverflowError.
    far = {"future.chat": 10**15, "beyond.chat": 10**20}
    real_stat = Path.stat

    def stat(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if path.name not in far:
            return result
        fields = list(result)
        fields[8] = far[path.name]
        return os.stat_result(fields)

    monkeypatch.setattr(Path, "stat", stat)
    listing = sessions.list_sessions("project", project, {})
    # The unreadable chat is still listed under its name; those no date can hold are skipped.
    assert [(session["path"], session["title"]) for session in listing] == [
        ("project/chats/deep.chat", "deep"),
        ("project/chats/talk.chat", "A real question"),
    ]


def test_sessions_are_listed_newest_first_from_chats_and_the_project_root(tmp_path):
    root = tmp_path / "root"
    project = root / "project"
    project.mkdir(parents=True)
    write_chat(project / "chats" / "older.chat", chat(message("An older question"), message("Reply", sender=CODEX, time=2.0)), 1_000)
    write_chat(project / "chats" / "newer.chat", chat(message("The newest question")), 3_000)
    write_chat(project / "untitled1.chat", chat(message("", sender=CODEX)), 2_000)
    write_chat(project / "chats" / ".hidden.chat", chat(message("hidden")), 4_000)
    (project / "chats" / "folder.chat").mkdir()
    (project / "chats" / "notes.txt").write_text("not a chat")
    (project / "chats" / ".ipynb_checkpoints").mkdir()
    write_chat(project / "chats" / ".ipynb_checkpoints" / "newer-checkpoint.chat", chat(message("checkpoint")), 5_000)
    activity = {"project/chats/older.chat": {"state": "working", "persona": CODEX, "since": "now"}}

    listing = sessions.list_sessions("project", project, activity)

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


def test_a_project_without_chats_lists_nothing(tmp_path):
    assert sessions.list_sessions("", tmp_path, {}) == []
    assert sessions.chats_directory("") == "chats"
    assert sessions.chats_directory("a/b") == "a/b/chats"


@pytest.mark.parametrize("entrypoint, expected", [
    ("astra.yaml", ""),
    ("./astra.yaml", ""),
    ("project/astra.yaml", "project"),
    ("team//project/./astra.yaml/", "team/project"),
])
def test_the_project_keeps_the_contents_path_its_entrypoint_names(entrypoint, expected):
    assert sessions.project_contents_path(entrypoint) == expected


def test_exclude_rules_are_relative_to_the_repository_root(tmp_path):
    assert sessions.exclude_patterns(tmp_path, tmp_path) == ["/chats/", "/*.chat"]
    nested = tmp_path / "team" / "project"
    nested.mkdir(parents=True)
    assert sessions.exclude_patterns(nested, tmp_path) == ["/team/project/chats/", "/team/project/*.chat"]


def test_exclude_rules_quote_wildcards_in_folder_names(tmp_path):
    nested = tmp_path / "draft [v2]" / "a*b?c\\d"
    nested.mkdir(parents=True)
    assert sessions.exclude_patterns(nested, tmp_path) == [
        "/draft \\[v2]/a\\*b\\?c\\\\d/chats/",
        "/draft \\[v2]/a\\*b\\?c\\\\d/*.chat",
    ]
    spanning = tmp_path / "two\nlines"
    spanning.mkdir()
    with pytest.raises(ValueError):
        sessions.exclude_patterns(spanning, tmp_path)


def test_excluding_chats_of_a_folder_named_like_a_wildcard_hides_only_its_own(tmp_path):
    git(tmp_path, "init", "-q")
    for folder in ("draft [v2]", "draftv"):
        write_chat(tmp_path / folder / "chats" / "talk.chat", chat(message("Hello")))
        write_chat(tmp_path / folder / "loose.chat", chat(message("Hello")))
    assert sessions.exclude_chats(tmp_path / "draft [v2]") is True
    assert git(tmp_path, "status", "--porcelain", "--untracked-files=all").splitlines() == [
        "?? draftv/chats/talk.chat",
        "?? draftv/loose.chat",
    ]


def test_excluding_chats_appends_once_after_any_last_line(tmp_path):
    git(tmp_path, "init", "-q")
    exclude = tmp_path / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text("/results/README.md")
    assert sessions.exclude_chats(tmp_path) is True
    assert exclude.read_text() == "/results/README.md\n/chats/\n/*.chat\n"
    assert sessions.exclude_chats(tmp_path) is False
    assert exclude.read_text() == "/results/README.md\n/chats/\n/*.chat\n"


def test_excluding_chats_creates_a_missing_exclude_file(tmp_path):
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-q")
    exclude = repository / ".git" / "info" / "exclude"
    if exclude.exists():
        exclude.unlink()
        exclude.parent.rmdir()
    assert sessions.exclude_chats(repository) is True
    assert exclude.read_text() == "/chats/\n/*.chat\n"
    ignored = git(repository, "check-ignore", "chats/talk.chat", "talk.chat", "src/talk.chat", "notes.md")
    assert ignored.splitlines() == ["chats/talk.chat", "talk.chat"]


def test_a_folder_outside_any_repository_is_left_alone(tmp_path):
    assert sessions.exclude_chats(tmp_path) is False
    assert not (tmp_path / ".git").exists()


def test_a_missing_git_executable_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "nowhere"))
    assert sessions.exclude_chats(tmp_path) is False


def test_an_unwritable_exclude_file_is_an_error(tmp_path):
    git(tmp_path, "init", "-q")
    exclude = tmp_path / ".git" / "info" / "exclude"
    exclude.unlink(missing_ok=True)
    exclude.mkdir(parents=True)
    with pytest.raises(OSError):
        sessions.exclude_chats(tmp_path)


async def test_the_listing_endpoint_reports_sessions_and_their_activity(jp_fetch, jp_serverapp, project):
    # Seeded through the persona manager's own accessor, so writer and reader must agree.
    agent_workspace = pytest.importorskip("jupyterlab_lightcone.agent_workspace")
    write_chat(project / "chats" / "talk.chat", chat(message("Fit the cosmology"), message("Done", sender=CODEX, time=2.0)), 2_000)
    write_chat(project / "chats" / "quiet.chat", chat(message("Quiet one")), 1_000)
    jp_serverapp.web_app.settings.pop(SESSION_ACTIVITY, None)
    agent_workspace.session_activity(jp_serverapp.web_app)["project/chats/talk.chat"] = {
        "state": "working", "persona": CODEX, "since": "2026-09-23T00:00:00+00:00",
    }
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})
    assert response.code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = json.loads(response.body)
    assert body["directory"] == "project/chats"
    assert [(session["title"], session["activity"], session["lastAgent"]) for session in body["sessions"]] == [
        ("Fit the cosmology", "working", "Codex"),
        ("Quiet one", "idle", None),
    ]


async def test_the_listing_endpoint_works_without_any_activity_registry(jp_fetch, jp_serverapp, project):
    jp_serverapp.web_app.settings.pop(SESSION_ACTIVITY, None)
    write_chat(project / "chats" / "talk.chat", chat(message("Hello")))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    assert [session["activity"] for session in body["sessions"]] == ["idle"]


async def test_a_malformed_chat_does_not_break_the_listing_endpoint(jp_fetch, project):
    write_chat(project / "chats" / "talk.chat", chat(message("Hello")), 1_000)
    write_chat(project / "chats" / "deep.chat", "[" * 200_000, 2_000)
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    assert [session["title"] for session in body["sessions"]] == ["deep", "Hello"]


async def test_a_project_reached_through_a_symlink_keeps_its_contents_paths(jp_fetch, jp_serverapp, jp_root_dir):
    real = jp_root_dir / "real" / "project"
    write_chat(real / "chats" / "talk.chat", chat(message("Through the link")))
    (real / "astra.yaml").write_text("name: linked\n")
    (jp_root_dir / "link").symlink_to(real, target_is_directory=True)
    jp_serverapp.web_app.settings[SESSION_ACTIVITY] = {
        "link/chats/talk.chat": {"state": "working", "persona": CODEX, "since": "2026-09-23T00:00:00+00:00"},
    }
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "link/astra.yaml"})).body)
    assert body["directory"] == "link/chats"
    assert [(session["path"], session["activity"]) for session in body["sessions"]] == [("link/chats/talk.chat", "working")]
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "link/astra.yaml"}))
    assert json.loads(response.body) == {"directory": "link/chats"}


async def test_a_symlinked_entrypoint_lists_the_chats_beside_the_link(jp_fetch, jp_root_dir):
    shared = jp_root_dir / "shared"
    write_chat(shared / "chats" / "elsewhere.chat", chat(message("Beside the target")))
    (shared / "astra.yaml").write_text("name: shared\n")
    project = jp_root_dir / "project"
    project.mkdir()
    (project / "astra.yaml").symlink_to(shared / "astra.yaml")
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "project/astra.yaml"}))
    assert json.loads(response.body) == {"directory": "project/chats"}
    write_chat(project / "chats" / "talk.chat", chat(message("Beside the link")))
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"})).body)
    # The chats the browser creates in the reported folder, never the target's.
    assert body["directory"] == "project/chats"
    assert [(session["path"], session["title"]) for session in body["sessions"]] == [("project/chats/talk.chat", "Beside the link")]


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


async def test_preparing_creates_the_chats_folder_through_the_contents_manager(jp_fetch, jp_serverapp, jp_root_dir, monkeypatch):
    project = jp_root_dir / "fresh"
    project.mkdir()
    (project / "astra.yaml").write_text("name: fresh\n")
    manager = jp_serverapp.contents_manager
    original = manager.new
    created = []

    async def new(model=None, path=""):
        created.append((model, path))
        return await original(model=model, path=path)

    monkeypatch.setattr(manager, "new", new)
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "fresh/astra.yaml"}))
    assert response.code == 200
    assert json.loads(response.body) == {"directory": "fresh/chats"}
    assert (project / "chats").is_dir()
    assert created == [({"type": "directory"}, "fresh/chats")]
    # Preparing again is idempotent and creates nothing anew.
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "fresh/astra.yaml"}))
    assert json.loads(response.body) == {"directory": "fresh/chats"}
    assert created == [({"type": "directory"}, "fresh/chats")]
    assert not (project / ".git").exists()


async def test_preparing_excludes_chats_from_the_projects_git_status(jp_fetch, project):
    git(project, "init", "-q")
    write_chat(project / "chats" / "talk.chat", chat(message("Hello")))
    write_chat(project / "loose.chat", chat(message("Hello")))
    assert git(project, "status", "--porcelain")
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "project/astra.yaml"}))
    assert response.code == 200
    exclude = (project / ".git" / "info" / "exclude").read_text()
    assert exclude.endswith("/chats/\n/*.chat\n")
    assert git(project, "status", "--porcelain", "--untracked-files=all").splitlines() == ["?? astra.yaml"]
    await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "project/astra.yaml"}))
    assert (project / ".git" / "info" / "exclude").read_text() == exclude


async def test_preparing_a_project_nested_in_a_repository_targets_its_own_chats(jp_fetch, jp_root_dir, project):
    git(jp_root_dir, "init", "-q")
    write_chat(project / "chats" / "talk.chat", chat(message("Hello")))
    await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "project/astra.yaml"}))
    exclude = (jp_root_dir / ".git" / "info" / "exclude").read_text()
    assert exclude.endswith("/project/chats/\n/project/*.chat\n")
    assert git(jp_root_dir, "status", "--porcelain", "--untracked-files=all").splitlines() == ["?? project/astra.yaml"]


async def test_preparing_reports_a_failed_exclusion_but_still_prepares(jp_fetch, jp_root_dir, caplog):
    project = jp_root_dir / "fresh"
    project.mkdir()
    (project / "astra.yaml").write_text("name: fresh\n")
    git(project, "init", "-q")
    exclude = project / ".git" / "info" / "exclude"
    exclude.unlink(missing_ok=True)
    exclude.mkdir(parents=True)
    with caplog.at_level(logging.WARNING, logger=server_log().name):
        response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "fresh/astra.yaml"}))
    assert response.code == 200
    assert json.loads(response.body) == {"directory": "fresh/chats"}
    assert (project / "chats").is_dir()
    warnings_logged = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert [record.getMessage() for record in warnings_logged] == [f"Could not exclude chats from the Git status of {project.resolve()}"]
    assert warnings_logged[0].exc_info is not None


async def test_preparing_a_project_at_the_server_root(jp_fetch, jp_root_dir):
    (jp_root_dir / "astra.yaml").write_text("name: root\n")
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "astra.yaml"}))
    assert json.loads(response.body) == {"directory": "chats"}
    assert (jp_root_dir / "chats").is_dir()
    body = json.loads((await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).body)
    assert body == {"directory": "chats", "sessions": []}


@pytest.mark.parametrize("body, status", [
    ("{}", 400),
    ('["project/astra.yaml"]', 400),
    ('{"path": 1}', 400),
    ('{"path": "../outside/astra.yaml"}', 400),
    ('{"path": "missing/astra.yaml"}', 404),
])
async def test_malformed_preparation_requests_change_nothing(jp_fetch, jp_root_dir, project, body, status):
    response = await jp_fetch(*ENDPOINT, method="POST", body=body, raise_error=False)
    assert response.code == status
    assert not (jp_root_dir / "missing").exists()


async def test_preparing_requires_write_permission(jp_fetch, jp_serverapp, jp_root_dir, monkeypatch):
    (jp_root_dir / "astra.yaml").write_text("name: root\n")
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda handler, user, action, resource: action != "write")
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "astra.yaml"}), raise_error=False)
    assert response.code == 403
    assert not (jp_root_dir / "chats").exists()
    # Reading stays allowed.
    assert (await jp_fetch(*ENDPOINT, params={"path": "astra.yaml"})).code == 200


async def test_listing_requires_contents_authorization(jp_fetch, jp_serverapp, project, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", lambda *args, **kwargs: False)
    response = await jp_fetch(*ENDPOINT, params={"path": "project/astra.yaml"}, raise_error=False)
    assert response.code == 403


async def test_requires_authentication(jp_fetch, project):
    for method, kwargs in (("GET", {"params": {"path": "project/astra.yaml"}}), ("POST", {"body": '{"path": "project/astra.yaml"}'})):
        response = await jp_fetch(*ENDPOINT, method=method, follow_redirects=False, headers={"Authorization": ""}, raise_error=False, **kwargs)
        assert response.code in (302, 403)


def test_every_verb_is_decorated_for_authentication(jp_serverapp):
    with warnings.catch_warnings(record=True) as records:
        warnings.simplefilter("always")
        setup_session_handlers(jp_serverapp.web_app)
    assert not [record for record in records if issubclass(record.category, JupyterServerAuthWarning)]


# --- full-text search ----------------------------------------------------------

SEARCH = (*ENDPOINT, "search")


def test_search_finds_messages_case_insensitively_newest_first(tmp_path):
    project = tmp_path / "project"
    write_chat(project / "chats" / "fit.chat", chat(
        message("Plot the Hubble residuals", time=10.0),
        message("I plotted the HUBBLE residuals versus redshift.", sender=CODEX, time=20.0),
        message("Something else entirely", time=30.0),
    ))
    write_chat(project / "old.chat", chat(message("An older hubble question", time=5.0)))
    matches = sessions.search_sessions("project", project, "hubble")
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


def test_search_snippets_are_cut_around_the_match_and_matches_are_bounded(tmp_path, monkeypatch):
    project = tmp_path / "project"
    body = "a " * 100 + "needle" + "\n b" * 100
    write_chat(project / "chats" / "long.chat", chat(*(message(body, time=float(i)) for i in range(5))))
    monkeypatch.setattr(sessions, "MAX_SEARCH_MATCHES", 3)
    matches = sessions.search_sessions("project", project, "needle")
    assert len(matches) == 3
    text = matches[0]["snippet"]
    assert text.startswith("…") and text.endswith("…") and "needle" in text and "\n" not in text
    # A query is literal text, never a pattern.
    assert sessions.search_sessions("project", project, "a.*needle") == []


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
