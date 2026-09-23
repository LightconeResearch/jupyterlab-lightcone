"""Run history read from Git, and materialization jobs supervised as process groups."""

import asyncio
import inspect
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import textwrap
import time
import warnings

from jupyter_events.logger import EventLogger
from jupyter_server.utils import JupyterServerAuthWarning
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import runs

ENDPOINT = ("jupyterlab_lightcone", "api", "runs")

RECORD_BODY = textwrap.dedent(
    """\
    [DATALAD RUNCMD] cosmology_contours [baseline]

    === Do not change lines below ===
    {
     "chain": [],
     "cmd": "uv run --no-project --with 'lightcone-cli==0.5.0rc2' -- python -m lightcone.engine.worker baseline/cosmology_contours",
     "dsid": "1b6baf0f-b6ee-42b7-b2bb-9c97c2c5a388",
     "exit": 0,
     "inputs": [
      "results/baseline/cosmology_fit.json",
      "src/plot_contours.py"
     ],
     "outputs": [
      "results/baseline/cosmology_contours.png",
      "results/baseline/.cosmology_contours.manifest.json"
     ],
     "pwd": "."
    }
    ^^^ Do not change lines above ^^^
    """
)

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.org",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.org",
}


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, env=GIT_ENV, check=True, capture_output=True, text=True).stdout


def commit(repo, name, message):
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(name)
    git(repo, "add", name)
    subprocess.run(["git", "commit", "-q", "-F", "-"], cwd=repo, env=GIT_ENV, check=True, input=message, text=True)
    return git(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q")
    return tmp_path


# =============================================================================
# Run history
# =============================================================================


def test_parses_the_engines_run_record():
    run = runs.parse_run("a" * 40 + "\x1f2026-09-20T13:51:26+02:00\x1f[DATALAD RUNCMD] cosmology_contours [baseline]\x1f" + RECORD_BODY)
    assert run == {
        "commit": "a" * 40,
        "short": "aaaaaaa",
        "time": "2026-09-20T13:51:26+02:00",
        "output": "cosmology_contours",
        "universe": "baseline",
        "cmd": "uv run --no-project --with 'lightcone-cli==0.5.0rc2' -- python -m lightcone.engine.worker baseline/cosmology_contours",
        "exit": 0,
        "inputs": ["results/baseline/cosmology_fit.json", "src/plot_contours.py"],
        "outputs": ["results/baseline/cosmology_contours.png", "results/baseline/.cosmology_contours.manifest.json"],
    }


@pytest.mark.parametrize("entry", ["", "abc\x1ftime\x1fsubject", "abc\x1ftime\x1fUpdate astra.yaml\x1fbody", "abc\x1ftime\x1f[DATALAD RUNCMD] fit\x1fbody"])
def test_ordinary_commits_are_not_runs(entry):
    assert runs.parse_run(entry) is None


@pytest.mark.parametrize("body", ["", "=== Do not change lines below ===\nnot json\n^^^ Do not change lines above ^^^", "=== Do not change lines below ===\n[1]\n^^^ Do not change lines above ^^^", "^^^ Do not change lines above ^^^\n=== Do not change lines below ==="])
def test_an_unreadable_record_keeps_the_run_with_empty_fields(body):
    assert runs.parse_run_record(body) == {"cmd": "", "exit": None, "inputs": [], "outputs": []}


def test_record_fields_are_typed():
    body = "=== Do not change lines below ===\n" + json.dumps({"cmd": 3, "exit": True, "inputs": ["a", 1], "outputs": "x"}) + "\n^^^ Do not change lines above ^^^"
    assert runs.parse_run_record(body) == {"cmd": "", "exit": None, "inputs": ["a"], "outputs": []}


def test_history_lists_only_run_commits_newest_first(repo):
    commit(repo, "astra.yaml", "Initial analysis\n")
    first = commit(repo, "results/baseline/fit.json", "[DATALAD RUNCMD] fit [baseline]\n\n=== Do not change lines below ===\n" + json.dumps({"cmd": "make fit", "exit": 0, "inputs": [], "outputs": ["results/baseline/fit.json"]}) + "\n^^^ Do not change lines above ^^^\n")
    commit(repo, "results/notes.md", "Notes mentioning [DATALAD RUNCMD] in the body\n\nNot a run.\n")
    second = commit(repo, "results/baseline/cosmology_contours.png", RECORD_BODY)
    history = runs.run_history(repo)
    assert [run["commit"] for run in history] == [second, first]
    assert history[0]["output"] == "cosmology_contours"
    assert history[0]["short"] == second[:7]
    assert history[1] == {
        "commit": first,
        "short": first[:7],
        "time": history[1]["time"],
        "output": "fit",
        "universe": "baseline",
        "cmd": "make fit",
        "exit": 0,
        "inputs": [],
        "outputs": ["results/baseline/fit.json"],
    }
    assert history[1]["time"].startswith("20")
    assert runs.run_history(repo, limit=1) == [history[0]]


def test_history_counts_only_runs_of_the_projects_own_results(repo):
    # One repository holding a project, a project nested in it, a sibling
    # project and other work: the engine adopts enclosing work trees.
    message = "[DATALAD RUNCMD] {} [baseline]\n"
    own = commit(repo, "a/results/baseline/fit.json", message.format("fit"))
    commit(repo, "a/b/results/baseline/nested.json", message.format("nested"))
    commit(repo, "c/results/baseline/sibling.json", message.format("sibling"))
    commit(repo, "private.json", message.format("private_output"))
    commit(repo, "a/notes.json", message.format("not_a_result"))
    assert [run["commit"] for run in runs.run_history(repo / "a")] == [own]
    assert runs.run_history(repo) == []


def test_history_is_empty_outside_git_and_in_an_empty_repository(tmp_path, monkeypatch):
    # Never find a repository above the temporary directory.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    plain = tmp_path / "plain"
    plain.mkdir()
    assert runs.run_history(plain) == []
    assert runs.run_history(tmp_path / "missing") == []
    empty = tmp_path / "empty"
    empty.mkdir()
    git(empty, "init", "-q")
    assert runs.run_history(empty) == []


# =============================================================================
# Jobs: pure helpers
# =============================================================================


def test_the_engine_is_run_through_this_interpreter():
    prefix = [sys.executable, "-c", "import sys; from lightcone.cli.commands import main; sys.exit(main())", "materialize", "--json"]
    assert runs.materialize_command([], False) == prefix
    assert runs.materialize_command(["fit", "baseline/contours"], True) == [*prefix, "--refresh", "fit", "baseline/contours"]


@pytest.mark.parametrize("targets", [[], ["fit"], ["baseline/fit", "sub.universe/plot_2"]])
def test_accepts_output_ids_as_targets(targets):
    assert runs.validate_targets(targets) == targets


@pytest.mark.parametrize("targets", ["fit", [1], ["--refresh"], ["-x"], [""], ["a b"], ["a\nb"], ["x" * 201], ["fit"] * 101, [None]])
def test_rejects_targets_that_are_not_output_ids(targets):
    with pytest.raises(HTTPError) as error:
        runs.validate_targets(targets)
    assert error.value.status_code == 400


def test_the_report_is_the_engines_json_ending_stdout():
    report = {"ok": True, "up_to_date": False, "made": ["baseline/fit"], "nested": {"a": [1, {"b": "}\n{"}]}}
    text = "image absent\n{\"draft\": 1}\n" + json.dumps(report, indent=2) + "\n\n"
    assert runs.parse_report(text) == report
    assert runs.parse_report("recipe output\n" + json.dumps(report)) == report
    # Printed without indentation, nested objects start lines too.
    assert runs.parse_report("x\n" + json.dumps(report, indent=0)) == report


@pytest.mark.parametrize("text", [
    "",
    "no json here\n{ broken\n",
    "[1, 2]\n",
    json.dumps({"ok": True, "up_to_date": True}) + "\ntrailing text\n",
    # Report-shaped JSON counts only when nothing follows it.
    json.dumps({"ok": True, "up_to_date": True}) + "\n" + json.dumps({"progress": 1}) + "\n",
    # A recipe's own JSON is not the report, even when it ends the output.
    json.dumps({"ok": True, "made": ["baseline/fit"]}) + "\n",
    json.dumps({"ok": "yes", "up_to_date": True}) + "\n",
    "{broken}\n",
    '{"a":' * 20000 + "1" + "}" * 20000,
])
def test_anything_else_on_stdout_is_no_report(text):
    assert runs.parse_report(text) is None


def test_hostile_stdout_cannot_stall_the_report_search():
    # Every line opens a document that runs to the end: tried one by one,
    # these took seconds to reject.
    text = ('{"a": [' + "1," * 500 + "\n") * 1000 + "1" + "]}" * 1000 + "\n"
    started = time.monotonic()
    assert runs.parse_report(text) is None
    assert time.monotonic() - started < 1


@pytest.mark.parametrize("chunks, lines", [
    (["a\nb", "c\n", "d"], ["a", "bc", "d"]),
    (["crlf\r", "\n"], ["crlf"]),
    (["\x1b[32mgreen\x1b[0m\n"], ["green"]),
    # A carriage return redraws the line: a progress bar keeps its last state.
    (["\r 10%", "\r 50%\r", "100%\n"], ["100%"]),
    (["\r 10%\r 20%\r\n"], [" 20%"]),
    # An overlong line is cut once, and the rest of it dropped.
    (["x" * 5000, "y\nz\n"], ["x" * runs.MAX_LINE_CHARS + runs.LINE_CUT, "z"]),
    (["x" * 5000], ["x" * runs.MAX_LINE_CHARS + runs.LINE_CUT]),
    (["tail\r"], ["tail"]),
    (["\r"], []),
])
def test_output_is_cut_into_display_lines(chunks, lines):
    splitter = runs.LineSplitter()
    received = [line for chunk in chunks for line in splitter.feed(chunk)]
    assert received + splitter.close() == lines


def test_an_unfinished_line_is_held_in_bounded_memory():
    splitter = runs.LineSplitter()
    for percent in range(100000):
        assert splitter.feed(f"\rfitting {percent}%") == []
    assert splitter.pending == "fitting 99999%"
    assert splitter.close() == ["fitting 99999%"]


def test_only_the_end_of_stdout_is_kept():
    tail = runs.OutputTail(10)
    for chunk in ("abc", "", "defgh", "ijklmnop", "q"):
        tail.append(chunk)
    assert tail.text() == "hijklmnopq"
    assert [*tail.chunks] == ["defgh", "ijklmnop", "q"]
    tail.clear()
    assert tail.text() == "" and tail.size == 0


def test_the_event_schema_accepts_exactly_the_job_events():
    logger = EventLogger()
    logger.register_event_schema(runs.JOB_SCHEMA_PATH)
    for data in ({"id": "x", "project": "", "state": "running", "line": None}, {"id": "x", "project": "p", "state": "failed", "line": "Error: dirty tree"}):
        logger.schemas.validate_event(runs.JOB_SCHEMA_ID, data)
    for data in ({"id": "x", "project": "p", "state": "lost", "line": None}, {"id": "x", "project": "p", "state": "running"}, {"id": 1, "project": "p", "state": "running", "line": None}):
        with pytest.raises(Exception):
            logger.schemas.validate_event(runs.JOB_SCHEMA_ID, data)


def test_registering_the_schema_twice_is_harmless(jp_serverapp):
    runs.setup_job_events(jp_serverapp)
    runs.setup_job_events(jp_serverapp)
    assert runs.JOB_SCHEMA_ID in jp_serverapp.event_logger.schemas


def test_routes_are_registered_once_and_every_verb_requires_authentication(jp_serverapp, monkeypatch):
    web_app = jp_serverapp.web_app
    # The extension registered the routes when it loaded: start over, so that
    # they really are added, and checked, here.
    monkeypatch.delitem(web_app.settings, runs.HANDLERS_SETTING)
    rules = len(web_app.default_router.rules)

    def register():
        with warnings.catch_warnings(record=True) as records:
            warnings.simplefilter("always")
            runs.setup_runs_handlers(web_app)
        return [record for record in records if issubclass(record.category, JupyterServerAuthWarning)]

    assert register() == []
    assert len(web_app.default_router.rules) == rules + 1
    assert register() == []
    assert len(web_app.default_router.rules) == rules + 1
    # The check is live: a verb without its decorators is reported.
    monkeypatch.setattr(runs.RunHandler, "delete", inspect.unwrap(runs.RunHandler.delete))
    del web_app.settings[runs.HANDLERS_SETTING]
    assert register() != []


# =============================================================================
# Jobs: fake engines
# =============================================================================


def fake_engine(tmp_path, body):
    script = tmp_path / "fake_engine.py"
    script.write_text("import json, os, signal, sys, time\n" + textwrap.dedent(body))
    return script


@pytest.fixture
def engine(tmp_path, monkeypatch):
    """Replace the engine command with a script; targets and refresh become its arguments."""

    def install(body):
        script = fake_engine(tmp_path, body)
        monkeypatch.setattr(runs, "materialize_command", lambda targets, refresh: [sys.executable, str(script), *(["--refresh"] if refresh else []), *targets])
        return script

    return install


@pytest.fixture
def project(jp_root_dir):
    (jp_root_dir / "project").mkdir()
    (jp_root_dir / "project" / "astra.yaml").write_text("name: example\n")
    return "project/astra.yaml"


@pytest.fixture
def app(jp_serverapp):
    runs.setup_runs_handlers(jp_serverapp.web_app)
    runs.setup_job_events(jp_serverapp)
    return jp_serverapp


@pytest.fixture
def events(app):
    received = []

    async def listener(logger, schema_id, data):
        received.append(data)

    app.event_logger.add_listener(schema_id=runs.JOB_SCHEMA_ID, listener=listener)
    return received


async def finished(app, job_id, timeout=15):
    job = runs.job_registry(app.web_app.settings).jobs[job_id]
    await asyncio.wait_for(asyncio.shield(job.task), timeout)
    return job


async def settled(received, job_id, state):
    for _ in range(200):
        if any(event["id"] == job_id and event["state"] == state and event["line"] is None for event in received):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"no final {state} event for {job_id}")


SUCCESS = """
    sys.stderr.write("lock scan: 3 packages\\n")
    sys.stderr.flush()
    sys.stdout.write("\\x1b[32mmade\\x1b[0m " + " ".join(sys.argv[1:]) + "\\n")
    sys.stdout.write(json.dumps({"ok": True, "up_to_date": False, "made": ["baseline/fit"], "cwd": os.getcwd()}, indent=2) + "\\n")
"""


async def test_a_job_runs_the_engine_in_the_project_and_reports(app, jp_fetch, jp_root_dir, project, engine, events):
    engine(SUCCESS)
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project, "targets": ["baseline/fit"], "refresh": True}))
    assert response.code == 202
    job = json.loads(response.body)
    assert job["state"] == "running"
    assert job["project"] == "project"
    assert job["targets"] == ["baseline/fit"]
    assert job["refresh"] is True
    assert job["finished"] is None and job["exit"] is None and job["report"] is None
    assert response.headers["Cache-Control"] == "no-store"

    record = await finished(app, job["id"])
    assert record.state == "succeeded"
    response = await jp_fetch(*ENDPOINT, job["id"], params={"path": project})
    final = json.loads(response.body)
    assert final["state"] == "succeeded"
    assert final["exit"] == 0
    assert final["finished"] is not None
    assert final["report"]["made"] == ["baseline/fit"]
    assert final["report"]["cwd"] == str((jp_root_dir / "project").resolve())
    assert final["lines"][:2] == ["lock scan: 3 packages", "made --refresh baseline/fit"]
    assert final["lines"][2] == "{"

    await settled(events, job["id"], "succeeded")
    assert events[0] == {"id": job["id"], "project": "project", "state": "running", "line": None}
    assert {"id": job["id"], "project": "project", "state": "running", "line": "made --refresh baseline/fit"} in events
    assert events[-1] == {"id": job["id"], "project": "project", "state": "succeeded", "line": None}

    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": project})).body)
    assert listing["runs"] == []
    assert [item["id"] for item in listing["jobs"]] == [job["id"]]
    assert listing["jobs"][0]["state"] == "succeeded"


async def test_engine_refusals_reach_the_lines_and_the_job_fails(app, jp_fetch, project, engine):
    engine(
        """
        sys.stderr.write("Error: the working tree is dirty; commit or stash:\\n  astra.yaml\\n")
        sys.exit(1)
        """
    )
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project, "targets": [], "refresh": False}))
    job = json.loads(response.body)
    record = await finished(app, job["id"])
    assert record.state == "failed"
    payload = record.payload()
    assert payload["exit"] == 1
    assert payload["lines"] == ["Error: the working tree is dirty; commit or stash:", "  astra.yaml"]
    assert payload["report"] is None


async def test_a_missing_engine_fails_the_job_instead_of_the_server(app, jp_fetch, project, monkeypatch):
    monkeypatch.setattr(runs, "materialize_command", lambda targets, refresh: ["/nonexistent/lightcone-engine"])
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))
    job = json.loads(response.body)
    record = await finished(app, job["id"])
    assert record.state == "failed"
    assert record.exit is None
    assert record.lines[0].startswith("Could not start the Lightcone engine:")


async def test_the_line_log_is_bounded_and_the_report_still_parsed(app, jp_fetch, project, engine):
    engine(
        """
        for i in range(500):
            sys.stdout.write(f"line {i}\\n")
        sys.stdout.write(json.dumps({"ok": True, "up_to_date": True}) + "\\n")
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    assert len(record.lines) == runs.MAX_LINES
    assert record.lines[0] == f"line {500 - runs.MAX_LINES + 1}"
    assert record.lines[-1] == '{"ok": true, "up_to_date": true}'
    assert record.report == {"ok": True, "up_to_date": True}
    # The output the report came from is not kept once the job finished.
    assert record.stdout.text() == ""


async def test_characters_split_across_reads_stay_whole(app, jp_fetch, project, engine):
    engine(
        """
        sys.stdout.buffer.write(b"caf\\xc3")
        sys.stdout.buffer.flush()
        time.sleep(0.3)
        sys.stdout.buffer.write(b"\\xa9\\r\\n")
        sys.stdout.buffer.flush()
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    assert list(record.lines) == ["café"]


async def test_long_lines_are_cut_and_progress_bars_keep_their_last_state(app, jp_fetch, project, engine, events):
    engine(
        """
        for percent in range(0, 101, 10):
            sys.stderr.write(f"\\rfitting {percent:3d}%")
            sys.stderr.flush()
        sys.stderr.write("\\n")
        sys.stdout.write("x" * 70000)
        sys.stdout.flush()
        time.sleep(0.2)
        sys.stdout.write("y" * 10 + "\\n")
        sys.stdout.write(json.dumps({"ok": True, "up_to_date": True}) + "\\n")
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    cut = "x" * runs.MAX_LINE_CHARS + runs.LINE_CUT
    assert sorted(record.lines) == sorted(["fitting 100%", cut, '{"ok": true, "up_to_date": true}'])
    assert record.report == {"ok": True, "up_to_date": True}
    await settled(events, job["id"], "succeeded")
    assert max(len(event["line"] or "") for event in events) == len(cut)


async def test_hostile_json_on_stdout_neither_breaks_the_job_nor_locks_the_project(app, jp_fetch, project, engine, events):
    engine(
        """
        depth = 20000
        sys.stdout.write('{"a":' * depth + "1" + "}" * depth + "\\n")
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    assert record.state == "succeeded"
    assert record.report is None
    await settled(events, job["id"], "succeeded")
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))
    assert response.code == 202
    await finished(app, json.loads(response.body)["id"])


async def test_a_recipes_json_is_never_taken_for_the_report(app, jp_fetch, project, engine):
    engine(
        """
        sys.stdout.write(json.dumps({"ok": True, "made": ["baseline/fit"]}) + "\\n")
        sys.stdout.flush()
        sys.stderr.write("Traceback (most recent call last):\\nRuntimeError: the engine crashed\\n")
        sys.exit(1)
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    assert record.state == "failed"
    assert record.report is None
    assert "RuntimeError: the engine crashed" in record.lines


async def test_cancelling_terminates_the_process_group(app, jp_fetch, project, engine, events):
    engine(
        """
        import subprocess
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        sys.stdout.write(f"child {child.pid}\\n")
        sys.stdout.flush()
        time.sleep(120)
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = runs.job_registry(app.web_app.settings).jobs[job["id"]]
    for _ in range(500):
        if record.lines:
            break
        await asyncio.sleep(0.01)
    child_pid = int(record.lines[0].split()[1])
    response = await jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project})
    cancelled = json.loads(response.body)
    assert cancelled["state"] == "cancelled"
    assert cancelled["finished"] is not None
    assert cancelled["exit"] not in (None, 0)
    for _ in range(100):
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("the grandchild survived the cancellation")
    await settled(events, job["id"], "cancelled")
    # Cancelling again changes nothing.
    again = json.loads((await jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project})).body)
    assert again == cancelled


async def test_a_job_cancelled_while_its_engine_spawns_never_runs(app, jp_fetch, project, engine, monkeypatch, events):
    engine("time.sleep(120)\n")
    spawning = asyncio.Event()
    release = asyncio.Event()
    spawn = asyncio.create_subprocess_exec

    async def held_spawn(*args, **kwargs):
        spawning.set()
        await release.wait()
        return await spawn(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", held_spawn)
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    await asyncio.wait_for(spawning.wait(), 5)
    record = runs.job_registry(app.web_app.settings).jobs[job["id"]]
    deleting = asyncio.ensure_future(jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project}))
    for _ in range(500):
        if record.state == "cancelled":
            break
        await asyncio.sleep(0.01)
    assert record.state == "cancelled" and record.process is None
    release.set()
    cancelled = json.loads((await asyncio.wait_for(deleting, 10)).body)
    assert cancelled["state"] == "cancelled"
    assert cancelled["finished"] is not None
    assert cancelled["exit"] in (-signal.SIGTERM, -signal.SIGKILL)
    with pytest.raises(ProcessLookupError):
        os.kill(record.process.pid, 0)
    # No start event: listeners hear of the job once, when it is final.
    await settled(events, job["id"], "cancelled")
    assert [event for event in events if event["id"] == job["id"]] == [
        {"id": job["id"], "project": "project", "state": "cancelled", "line": None}
    ]


async def test_cancelling_after_the_engine_exited_keeps_its_outcome(app, jp_fetch, project, engine, events):
    engine(
        """
        import subprocess
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        sys.stdout.write(f"child {child.pid}\\n")
        sys.stdout.write(json.dumps({"ok": True, "up_to_date": False, "made": ["baseline/fit"]}, indent=2) + "\\n")
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = runs.job_registry(app.web_app.settings).jobs[job["id"]]
    for _ in range(500):
        if record.lines and record.process is not None and record.process.returncode is not None:
            break
        await asyncio.sleep(0.01)
    # The engine is done; the grandchild still holds its pipes.
    assert record.process.returncode == 0
    assert record.state == "running"
    child_pid = int(record.lines[0].split()[1])
    final = json.loads((await jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project})).body)
    assert final["state"] == "succeeded"
    assert final["exit"] == 0
    assert final["report"]["made"] == ["baseline/fit"]
    assert not [event for event in events if event["state"] == "cancelled"]
    for _ in range(100):
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("the grandchild survived the cancellation")


async def test_an_engine_ignoring_sigterm_is_killed_after_the_grace_period(app, jp_fetch, project, engine):
    engine(
        """
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        sys.stdout.write("armed\\n")
        sys.stdout.flush()
        time.sleep(120)
        """
    )
    runs.job_registry(app.web_app.settings).grace = 0.3
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = runs.job_registry(app.web_app.settings).jobs[job["id"]]
    for _ in range(500):
        if record.lines:
            break
        await asyncio.sleep(0.01)
    cancelled = json.loads((await jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project})).body)
    assert cancelled["state"] == "cancelled"
    assert cancelled["exit"] == -9


async def test_one_running_job_per_project(app, jp_fetch, jp_root_dir, project, engine):
    engine("time.sleep(120)\n")
    (jp_root_dir / "other").mkdir()
    (jp_root_dir / "other" / "astra.yaml").write_text("name: other\n")
    first = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}), raise_error=False)
    assert response.code == 409
    other = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "other/astra.yaml"}))).body)
    assert other["project"] == "other"
    # A job is visible only through its own project.
    response = await jp_fetch(*ENDPOINT, first["id"], params={"path": "other/astra.yaml"}, raise_error=False)
    assert response.code == 404
    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": project})).body)
    assert [item["id"] for item in listing["jobs"]] == [first["id"]]
    await runs.close_jobs(app.web_app)
    for job_id in (first["id"], other["id"]):
        assert runs.job_registry(app.web_app.settings).jobs[job_id].state == "cancelled"
    # The project is free again once its job has stopped.
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))
    assert response.code == 202
    await runs.close_jobs(app.web_app)


async def test_jobs_keep_the_project_path_the_browser_uses(app, jp_fetch, jp_root_dir, engine, events):
    engine("time.sleep(120)\n")
    real = jp_root_dir / "projects" / "2026" / "proj"
    real.mkdir(parents=True)
    (real / "astra.yaml").write_text("name: proj\n")
    (jp_root_dir / "current").symlink_to(Path("projects") / "2026" / "proj", target_is_directory=True)
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": "current/astra.yaml"}))).body)
    assert job["project"] == "current"
    for _ in range(500):
        if events:
            break
        await asyncio.sleep(0.01)
    assert events[0] == {"id": job["id"], "project": "current", "state": "running", "line": None}
    # Every path to the directory sees the job and shares its one-job limit.
    real_entrypoint = "projects/2026/proj/astra.yaml"
    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": real_entrypoint})).body)
    assert [item["id"] for item in listing["jobs"]] == [job["id"]]
    assert (await jp_fetch(*ENDPOINT, job["id"], params={"path": real_entrypoint})).code == 200
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": real_entrypoint}), raise_error=False)
    assert response.code == 409
    await runs.close_jobs(app.web_app)


async def test_the_listing_keeps_the_newest_jobs_first_and_bounded(app, jp_fetch, project, engine):
    engine("pass\n")
    ids = []
    for _ in range(runs.MAX_JOBS + 3):
        job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
        await finished(app, job["id"])
        ids.append(job["id"])
    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": project})).body)["jobs"]
    assert [item["id"] for item in listing] == list(reversed(ids))[: runs.MAX_JOBS]
    assert len(runs.job_registry(app.web_app.settings).jobs) <= runs.MAX_JOBS + 1


async def test_history_and_jobs_are_served_together(app, jp_fetch, jp_root_dir, project):
    repo = jp_root_dir / "project"
    git(repo, "init", "-q")
    sha = commit(repo, "results/baseline/cosmology_contours.png", RECORD_BODY)
    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": project})).body)
    assert listing["jobs"] == []
    assert [run["commit"] for run in listing["runs"]] == [sha]
    assert listing["runs"][0]["universe"] == "baseline"


@pytest.mark.parametrize("body, status", [
    ("null", 400),
    ('{"targets": []}', 400),
    ('{"path": "project/astra.yaml", "targets": "fit"}', 400),
    ('{"path": "project/astra.yaml", "refresh": "yes"}', 400),
    ('{"path": "missing/astra.yaml"}', 404),
    ('{"path": "../outside/astra.yaml"}', 400),
    ('{"path": "project/other.yaml"}', 400),
])
async def test_start_validates_its_body(app, jp_fetch, project, body, status):
    response = await jp_fetch(*ENDPOINT, method="POST", body=body, raise_error=False)
    assert response.code == status


async def test_unknown_jobs_are_not_found(app, jp_fetch, project):
    for method in ("GET", "DELETE"):
        response = await jp_fetch(*ENDPOINT, "0" * 8 + "-0000-0000-0000-" + "0" * 12, method=method, params={"path": project}, raise_error=False)
        assert response.code == 404


@pytest.mark.parametrize("method, extra", [("GET", ()), ("POST", ()), ("GET", ("0" * 8 + "-0000-0000-0000-" + "0" * 12,)), ("DELETE", ("0" * 8 + "-0000-0000-0000-" + "0" * 12,))])
async def test_requires_authentication(app, jp_fetch, method, extra):
    kwargs = {"body": "{}"} if method == "POST" else {}
    response = await jp_fetch(*ENDPOINT, *extra, method=method, params={"path": "astra.yaml"}, follow_redirects=False, headers={"Authorization": ""}, raise_error=False, **kwargs)
    assert response.code in (302, 403)


@pytest.mark.parametrize("action, resource", [("read", "contents"), ("write", "contents"), ("execute", "lightcone")])
async def test_start_requires_every_permission(app, jp_fetch, project, engine, monkeypatch, action, resource):
    engine("pass\n")
    monkeypatch.setattr(app.authorizer, "is_authorized", lambda handler, user, a, r: (a, r) != (action, resource))
    response = await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}), raise_error=False)
    assert response.code == 403
    assert runs.job_registry(app.web_app.settings).jobs == {}


async def test_reading_requires_read_and_stopping_requires_write(app, jp_fetch, project, engine, monkeypatch):
    engine("time.sleep(120)\n")
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    monkeypatch.setattr(app.authorizer, "is_authorized", lambda handler, user, action, resource: action == "read")
    assert (await jp_fetch(*ENDPOINT, job["id"], params={"path": project})).code == 200
    response = await jp_fetch(*ENDPOINT, job["id"], method="DELETE", params={"path": project}, raise_error=False)
    assert response.code == 403
    monkeypatch.setattr(app.authorizer, "is_authorized", lambda *args: False)
    response = await jp_fetch(*ENDPOINT, params={"path": project}, raise_error=False)
    assert response.code == 403
    await runs.close_jobs(app.web_app)
