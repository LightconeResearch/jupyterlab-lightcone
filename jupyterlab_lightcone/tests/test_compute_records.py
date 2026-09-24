"""The cluster registry: the files `lc materialize` reads, and how they are written."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat

import pytest

from jupyterlab_lightcone.compute import records
from jupyterlab_lightcone.compute.records import FORMAT, Record


def mode(path: Path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def make_record(root: Path, **extra) -> Record:
    cluster_id = records.new_cluster_id()
    directory = records.make_directory(root, cluster_id)
    record = Record(directory, {"format": FORMAT, "id": cluster_id, "backend": "local", "label": "Local", **extra})
    records.write_record(record)
    return record


def test_ids_sort_by_creation_time_and_name_safe_directories():
    first = records.new_cluster_id(datetime(2026, 9, 24, 14, 15, 2, tzinfo=timezone.utc))
    later = records.new_cluster_id(datetime(2026, 9, 24, 14, 15, 3, tzinfo=timezone.utc))
    assert first.startswith("20260924-141502-")
    assert first < later
    assert records.is_cluster_id(first)
    assert not records.is_cluster_id("../etc")


def test_the_registry_is_private_to_its_owner(tmp_path):
    root = tmp_path / "clusters"
    record = make_record(root)
    assert mode(root) == 0o700
    assert mode(record.directory) == 0o700
    assert mode(record.path(records.RECORD_FILE)) == 0o600


def test_records_read_back_oldest_first(tmp_path):
    root = tmp_path / "clusters"
    first = make_record(root)
    second = make_record(root)
    assert [record.id for record in records.read_records(root)] == sorted([first.id, second.id])
    assert records.read_records(root)[0].data["label"] == "Local"


@pytest.mark.parametrize(
    "content",
    ["not json", "[]", json.dumps({"format": "lightcone.cluster/0", "id": "{id}"}), json.dumps({"format": FORMAT, "id": "20260101-000000-zzzz"})],
)
def test_foreign_or_damaged_records_are_skipped(tmp_path, content):
    root = tmp_path / "clusters"
    record = make_record(root)
    record.path(records.RECORD_FILE).write_text(content.replace("{id}", record.id))
    assert records.read_records(root) == []


def test_other_entries_in_the_registry_are_ignored(tmp_path):
    root = tmp_path / "clusters"
    root.mkdir()
    (root / "notes.txt").write_text("hello")
    (root / "not-a-cluster").mkdir()
    assert records.read_records(root) == []
    assert records.read_records(tmp_path / "missing") == []


def test_a_rewrite_replaces_the_record_whole(tmp_path):
    record = make_record(tmp_path / "clusters")
    record.data["local"] = {"pid": 42}
    records.write_record(record)
    assert json.loads(record.path(records.RECORD_FILE).read_text())["local"] == {"pid": 42}
    assert [path.name for path in record.directory.iterdir()] == [records.RECORD_FILE]


def test_tls_material_is_one_private_self_signed_pair(tmp_path):
    record = make_record(tmp_path / "clusters")
    record.data["tls"] = records.write_tls(record.directory)
    assert record.data["tls"] == {"ca": "tls/cert.pem", "cert": "tls/cert.pem", "key": "tls/key.pem"}
    assert "BEGIN CERTIFICATE" in record.path("tls/cert.pem").read_text()
    assert "PRIVATE KEY" in record.path("tls/key.pem").read_text()
    assert mode(record.path("tls/key.pem")) == 0o600
    assert mode(record.path("tls")) == 0o700
    security = records.security(record)
    assert security.require_encryption
    assert security.tls_client_key == str(record.path("tls/key.pem"))


def test_the_scheduler_file_is_read_only_once_complete(tmp_path):
    record = make_record(tmp_path / "clusters")
    assert records.read_scheduler_file(record) is None
    record.path(records.SCHEDULER_FILE).write_text('{"address": "tls://127.0')
    assert records.read_scheduler_file(record) is None
    record.path(records.SCHEDULER_FILE).write_text('{"address": "tls://127.0.0.1:4000", "services": {}}')
    assert records.read_scheduler_file(record)["address"] == "tls://127.0.0.1:4000"


def test_workers_follow_the_engines_contract(tmp_path):
    record = make_record(tmp_path / "clusters", tls={"ca": "tls/cert.pem", "cert": "tls/cert.pem", "key": "tls/key.pem"})
    argv = records.worker_arguments(record)
    assert argv[:2] == ["-m", "distributed.cli.dask_worker"]
    for flag in ("--no-nanny", "--no-dashboard"):
        assert flag in argv
    for flag, value in [
        ("--memory-limit", "0"),
        ("--nworkers", "1"),
        ("--death-timeout", "60"),
        ("--local-directory", "/tmp"),
        ("--protocol", "tls"),
        ("--scheduler-file", str(record.path(records.SCHEDULER_FILE))),
        ("--tls-key", str(record.path("tls/key.pem"))),
    ]:
        assert argv[argv.index(flag) + 1] == value


def test_the_scheduler_listens_with_tls_and_stops_when_idle(tmp_path):
    record = make_record(tmp_path / "clusters", tls={"ca": "tls/cert.pem", "cert": "tls/cert.pem", "key": "tls/key.pem"})
    argv = records.scheduler_argv("/usr/bin/python3", record, "127.0.0.1", 1800)
    assert argv[:3] == ["/usr/bin/python3", "-m", "distributed.cli.dask_scheduler"]
    assert argv[argv.index("--protocol") + 1] == "tls"
    assert argv[argv.index("--idle-timeout") + 1] == "1800s"
    assert argv[argv.index("--host") + 1] == "127.0.0.1"
    assert argv[argv.index("--dashboard-address") + 1] == "127.0.0.1:0"


def test_the_worker_environment_names_what_the_engine_checks():
    environment = records.worker_environment(image="ghcr.io/example/user:sha-1", interpreter=None)
    assert environment["image"] == "ghcr.io/example/user:sha-1"
    assert environment["interpreter"] is None
    assert environment["lightcone"] == records.package_version("lightcone-cli")
    assert environment["distributed"] == records.package_version("distributed")


async def test_registry_lock_excludes_other_processes_and_releases_on_exit(tmp_path):
    import asyncio
    import subprocess
    import sys

    probe = (
        "import fcntl, sys\n"
        "with open(sys.argv[1], 'r+') as lock:\n"
        " try:\n"
        "  fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
        " except BlockingIOError:\n"
        "  sys.exit(2)\n"
    )

    async def another_process():
        result = await asyncio.to_thread(
            subprocess.run, [sys.executable, "-c", probe, str(tmp_path / ".lock")],
            capture_output=True, timeout=5,
        )
        return result.returncode

    async with records.registry_lock(tmp_path):
        assert await another_process() == 2
        assert mode(tmp_path / ".lock") == 0o600
    assert await another_process() == 0


async def test_cancelling_a_lock_waiter_does_not_leave_a_lock_behind(tmp_path):
    import asyncio

    async def wait_for_lock():
        async with records.registry_lock(tmp_path):
            pass

    async with records.registry_lock(tmp_path):
        waiter = asyncio.create_task(wait_for_lock())
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
    await asyncio.wait_for(wait_for_lock(), timeout=1)
