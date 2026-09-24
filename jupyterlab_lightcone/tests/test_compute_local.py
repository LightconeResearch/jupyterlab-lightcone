"""Clusters on this host, started for real: a TLS scheduler and a worker as separate sessions."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import textwrap

import pytest
import psutil

from jupyterlab_lightcone.compute import local, records, service
from jupyterlab_lightcone.compute.backend import BackendError
from jupyterlab_lightcone.compute.local import LocalBackend
from jupyterlab_lightcone.compute.records import FORMAT, Record
from jupyterlab_lightcone.compute.service import ComputeService

pytestmark = pytest.mark.skipif(os.name != "posix", reason="local clusters need POSIX sessions")

ATTACH = textwrap.dedent(
    """\
    import json, sys
    from pathlib import Path
    from distributed import Client, Security

    directory = Path(sys.argv[1])
    record = json.loads((directory / "cluster.json").read_text())
    tls = record["tls"]
    security = Security(
        tls_ca_file=str(directory / tls["ca"]),
        tls_client_cert=str(directory / tls["cert"]),
        tls_client_key=str(directory / tls["key"]),
        require_encryption=True,
    )
    with Client(scheduler_file=str(directory / "scheduler.json"), security=security, timeout=30) as client:
        print(client.submit(lambda x: x + 1, 41).result(timeout=30))
    """
)


@pytest.fixture
def compute(tmp_path, monkeypatch):
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    monkeypatch.delenv("NERSC_HOST", raising=False)
    monkeypatch.setattr(service, "engine_attaches", lambda: True)
    return ComputeService([LocalBackend(idle_timeout=120)], base_url="/", idle_timeout=120, root=tmp_path / "clusters")


async def running(compute, timeout=60):
    """The cluster once its scheduler answers with its worker registered."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        compute.invalidate()
        cluster = next((t for t in (await compute.listing(None))["targets"] if t["kind"] == "cluster"), None)
        if cluster and cluster["state"] == "running" and cluster["load"] and cluster["load"]["workers"]:
            return cluster
        await asyncio.sleep(0.5)
    raise AssertionError("the local cluster did not start")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_a_local_cluster_starts_serves_another_process_and_stops(compute, tmp_path):
    created = await compute.create({"backend": "local", "label": "Local · 2 threads", "threads": 2}, None)
    assert created["state"] == "starting"
    cluster = await running(compute)
    assert cluster["active"] is True
    assert cluster["load"] == {"workers": 1, "threads": 2, "busy": 0}
    assert cluster["size"]["threads"] == 2
    directory = compute.root / cluster["id"]
    local = json.loads((directory / records.RECORD_FILE).read_text())["local"]
    assert local["host"] == socket.gethostname()
    assert json.loads((directory / records.SCHEDULER_FILE).read_text())["address"].startswith("tls://127.0.0.1:")

    # The contract the engine relies on: the record and its files are enough to attach.
    script = tmp_path / "attach.py"
    script.write_text(ATTACH)
    attached = await asyncio.to_thread(
        subprocess.run, [sys.executable, str(script), str(directory)], capture_output=True, text=True, timeout=90
    )
    assert attached.returncode == 0, attached.stderr
    assert attached.stdout.strip() == "42"

    # A replacement Jupyter server can still stop this host's recorded cluster.
    await LocalBackend(idle_timeout=120).stop(records.read_records(compute.root)[0])
    assert not directory.exists()
    assert not alive(local["pid"]) and not alive(local["worker"])
    compute.invalidate()
    listing = await compute.listing(None)
    assert [t["kind"] for t in listing["targets"]] == ["host"]
    assert listing["ended"] == []


async def test_closing_stops_what_this_server_launched(compute):
    await compute.create({"backend": "local", "label": "Local", "threads": 1}, None)
    cluster = await running(compute)
    pid = json.loads((compute.root / cluster["id"] / records.RECORD_FILE).read_text())["local"]["pid"]
    await compute.close()
    assert not alive(pid)
    assert records.read_records(compute.root) == []


def make_record(tmp_path, **local) -> Record:
    cluster_id = records.new_cluster_id()
    directory = records.make_directory(tmp_path / "clusters", cluster_id)
    return Record(
        directory,
        {"format": FORMAT, "id": cluster_id, "backend": "local", "label": "Local", "created": records.utc_now(), "local": local},
    )


async def test_statuses_follow_the_scheduler_process(tmp_path):
    backend = LocalBackend(idle_timeout=120)
    here = socket.gethostname()
    sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        elsewhere = make_record(tmp_path, host="another-host", pid=sleeper.pid)
        dead = make_record(tmp_path, host=here, pid=2**22 + 12345)
        impostor = make_record(tmp_path, host=here, pid=sleeper.pid)
        statuses = await backend.statuses([elsewhere, dead, impostor])
    finally:
        sleeper.kill()
        sleeper.wait()
    assert statuses[elsewhere.id].state == "unknown"
    assert (statuses[dead.id].state, statuses[dead.id].reason) == ("gone", "stopped")
    # A reused process id is not the scheduler.
    assert statuses[impostor.id].state == "gone"


def test_threads_default_to_every_core():
    backend = LocalBackend(idle_timeout=120)
    assert backend.validate({}) == {"threads": os.cpu_count() or 1}
    with pytest.raises(ValueError):
        backend.validate({"threads": 0})


@pytest.fixture
def processes():
    """Short-lived real processes, always reaped even if an assertion fails."""
    children = []

    def spawn(record, key="pid", *, module=None):
        role = "dask_scheduler" if key == "pid" else "dask_worker"
        child = subprocess.Popen(
            [sys.executable, "-m", module or f"distributed.cli.{role}", "--scheduler-file", str(record.path("scheduler.json"))],
            cwd=record.directory,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        children.append(child)
        record.data["local"][key] = child.pid
        record.data["local"][f"{key}_started"] = psutil.Process(child.pid).create_time()
        records.write_record(record)
        return child

    yield spawn
    for child in children:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)


@pytest.mark.parametrize("host", ["another-host", None])
async def test_stop_refuses_foreign_or_missing_host(tmp_path, monkeypatch, host):
    record = make_record(tmp_path, host=host, pid=os.getpid(), worker=os.getpid())
    records.write_record(record)
    signals = []
    monkeypatch.setattr(local.os, "killpg", lambda *args: signals.append(args))
    with pytest.raises(BackendError, match="host that started"):
        await LocalBackend(idle_timeout=120).stop(record)
    assert signals == []
    assert record.path(records.RECORD_FILE).exists()


@pytest.mark.parametrize("key", ["pid", "worker"])
@pytest.mark.parametrize("mismatch", ["directory", "creation_time"])
async def test_stop_never_signals_another_clusters_process(tmp_path, processes, key, mismatch):
    owner = make_record(tmp_path, host=socket.gethostname())
    child = processes(owner, key)
    if mismatch == "directory":
        impostor = make_record(tmp_path, **owner.data["local"])
    else:
        impostor = owner
        impostor.data["local"][f"{key}_started"] -= 1
    await LocalBackend(idle_timeout=120).stop(impostor)
    assert child.poll() is None
    assert not impostor.directory.exists()


async def test_legacy_records_require_the_exact_scheduler_file(tmp_path, processes):
    owner = make_record(tmp_path, host=socket.gethostname())
    child = processes(owner)
    owner.data["local"].pop("pid_started")
    impostor = make_record(tmp_path, **owner.data["local"])
    assert (await LocalBackend(idle_timeout=120).statuses([impostor]))[impostor.id].state == "gone"
    await LocalBackend(idle_timeout=120).stop(impostor)
    assert child.poll() is None
    await LocalBackend(idle_timeout=120).stop(owner)
    assert child.wait(timeout=10) != 0


async def test_a_live_worker_keeps_its_record_after_the_scheduler_exits(tmp_path, processes):
    record = make_record(tmp_path, host=socket.gethostname())
    processes(record, "worker")
    backend = LocalBackend(idle_timeout=120)
    assert (await backend.statuses([record]))[record.id].state == "stopping"
    assert record.path(records.RECORD_FILE).exists()
    await backend.stop(record)
    assert not record.directory.exists()


async def test_unverifiable_processes_keep_the_record(tmp_path, monkeypatch):
    record = make_record(tmp_path, host=socket.gethostname(), pid=12345)
    records.write_record(record)

    def denied(pid):
        raise psutil.AccessDenied(pid)

    monkeypatch.setattr(local.psutil, "Process", denied)
    backend = LocalBackend(idle_timeout=120)
    assert (await backend.statuses([record]))[record.id].state == "unknown"
    with pytest.raises(BackendError, match="verify"):
        await backend.stop(record)
    assert record.path(records.RECORD_FILE).exists()


async def test_a_denied_stop_keeps_its_record(tmp_path, processes, monkeypatch):
    record = make_record(tmp_path, host=socket.gethostname())
    child = processes(record)

    def denied(pid, signum):
        raise PermissionError("not permitted")

    monkeypatch.setattr(local.os, "killpg", denied)
    with pytest.raises(BackendError, match="Could not stop"):
        await LocalBackend(idle_timeout=120).stop(record)
    assert child.poll() is None
    assert record.path(records.RECORD_FILE).exists()


async def test_process_identity_is_checked_again_before_sigkill(tmp_path, processes, monkeypatch):
    record = make_record(tmp_path, host=socket.gethostname())
    child = processes(record)
    signals = []

    def signal_then_reuse(pid, signum):
        signals.append((pid, signum))
        # Simulate PID reuse between the polite stop and forced termination.
        record.data["local"]["pid_started"] -= 1

    monkeypatch.setattr(local.os, "killpg", signal_then_reuse)
    monkeypatch.setattr(local, "STOP_GRACE", 0)
    await LocalBackend(idle_timeout=120).stop(record)
    assert signals == [(child.pid, signal.SIGTERM)]
    assert child.poll() is None


async def test_worker_launch_failure_reaps_the_scheduler_and_removes_its_record(compute, monkeypatch):
    spawn = asyncio.create_subprocess_exec
    children = []

    async def fail_second_spawn(*args, **kwargs):
        if children:
            saved = records.read_records(compute.root)
            assert saved[0].section("local")["pid"] == children[0].pid
            raise OSError("worker spawn failed")
        child = await spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(local.asyncio, "create_subprocess_exec", fail_second_spawn)
    with pytest.raises(BackendError, match="worker spawn failed"):
        await compute.create({"backend": "local", "label": "Local", "threads": 1}, None)
    assert children[0].returncode is not None
    assert not alive(children[0].pid)
    assert records.read_records(compute.root) == []


async def test_cancelled_start_finishes_recording_before_cleanup(compute, monkeypatch):
    spawn = asyncio.create_subprocess_exec
    accepted = asyncio.Event()
    release = asyncio.Event()
    children = []

    async def delayed_spawn(*args, **kwargs):
        child = await spawn(*args, **kwargs)
        children.append(child)
        accepted.set()
        await release.wait()
        return child

    monkeypatch.setattr(local.asyncio, "create_subprocess_exec", delayed_spawn)
    creating = asyncio.create_task(compute.create({"backend": "local", "label": "Local", "threads": 1}, None))
    await asyncio.wait_for(accepted.wait(), 10)
    creating.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await creating
    assert all(child.returncode is not None for child in children)
    assert records.read_records(compute.root) == []
