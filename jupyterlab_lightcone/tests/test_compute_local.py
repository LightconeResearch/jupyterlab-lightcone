"""Clusters on this host, started for real: a TLS scheduler and a worker as separate sessions."""

import asyncio
import json
import os
import socket
import subprocess
import sys
import textwrap

import pytest

from jupyterlab_lightcone.compute import records, service
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

    await compute.stop(cluster["id"])
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
    if os.path.exists(f"/proc/{os.getpid()}/cmdline"):
        assert statuses[impostor.id].state == "gone"


def test_threads_default_to_every_core():
    backend = LocalBackend(idle_timeout=120)
    assert backend.validate({}) == {"threads": os.cpu_count() or 1}
    with pytest.raises(ValueError):
        backend.validate({"threads": 0})
