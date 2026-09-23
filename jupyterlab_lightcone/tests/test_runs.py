"""Run history read from Git, and materialization jobs supervised as process groups."""

import asyncio
import json
import os
import subprocess
import sys
import textwrap
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
    first = commit(repo, "fit.json", "[DATALAD RUNCMD] fit [baseline]\n\n=== Do not change lines below ===\n" + json.dumps({"cmd": "make fit", "exit": 0, "inputs": [], "outputs": ["results/baseline/fit.json"]}) + "\n^^^ Do not change lines above ^^^\n")
    commit(repo, "notes.md", "Notes mentioning [DATALAD RUNCMD] in the body\n\nNot a run.\n")
    second = commit(repo, "contours.png", RECORD_BODY)
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


def test_the_report_is_the_last_json_document_on_stdout():
    report = {"ok": True, "made": ["baseline/fit"], "nested": {"a": [1, {"b": "}"}]}}
    text = "image absent\n{\"draft\": 1}\n" + json.dumps(report, indent=2) + "\ntrailing text\n"
    assert runs.parse_last_json(text) == report
    assert runs.parse_last_json("no json here\n{ broken\n") is None
    assert runs.parse_last_json("") is None
    assert runs.parse_last_json("[1, 2]\n") is None


def test_contents_paths_of_projects(tmp_path):
    assert runs.contents_path(tmp_path, tmp_path) == ""
    assert runs.contents_path(tmp_path, tmp_path / "a" / "b") == "a/b"


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


def test_every_route_verb_requires_authentication(jp_serverapp):
    with warnings.catch_warnings(record=True) as records:
        warnings.simplefilter("always")
        runs.setup_runs_handlers(jp_serverapp.web_app)
        runs.setup_runs_handlers(jp_serverapp.web_app)
    assert not [record for record in records if issubclass(record.category, JupyterServerAuthWarning)]


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
        sys.stdout.write(json.dumps({"ok": True}) + "\\n")
        """
    )
    job = json.loads((await jp_fetch(*ENDPOINT, method="POST", body=json.dumps({"path": project}))).body)
    record = await finished(app, job["id"])
    assert len(record.lines) == runs.MAX_LINES
    assert record.lines[0] == f"line {500 - runs.MAX_LINES + 1}"
    assert record.lines[-1] == '{"ok": true}'
    assert record.report == {"ok": True}


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
    sha = commit(repo, "contours.png", RECORD_BODY)
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
