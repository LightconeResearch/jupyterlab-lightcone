"""What the Compute section lists: every place runs can go, and the one they will."""

import json

import pytest

from jupyterlab_lightcone.compute import records, service
from jupyterlab_lightcone.compute.backend import BackendError, PresetError, Status
from jupyterlab_lightcone.compute.service import ComputeService, ConflictError

from .compute_fixtures import FakeBackend

PRESET = {"backend": "slurm", "label": "Regular · 4 nodes · 2 h", "nodes": 4}


@pytest.fixture(autouse=True)
def plain_host(monkeypatch):
    """A workstation: no allocation, no HPC center, no JupyterHub."""
    for name in ("SLURM_JOB_ID", "SLURM_JOB_NUM_NODES", "SLURM_NNODES", "NERSC_HOST", "JUPYTERHUB_USER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(service, "engine_attaches", lambda: True)


@pytest.fixture
def slurm():
    return FakeBackend("slurm")


@pytest.fixture
def compute(tmp_path, slurm):
    return ComputeService([slurm], base_url="/", idle_timeout=1800, root=tmp_path / "clusters")


def clusters(listing):
    return [target for target in listing["targets"] if target["kind"] == "cluster"]


def host(listing):
    return listing["targets"][0]


async def fresh(compute):
    compute.invalidate()
    return await compute.listing(None)


async def test_without_clusters_runs_stay_on_this_host(compute):
    listing = await compute.listing(None)
    assert listing["format"] == records.FORMAT
    assert listing["backends"] == ["slurm"]
    assert listing["idleTimeout"] == 1800
    assert listing["targets"] == [host(listing)]
    assert host(listing)["variant"] == "machine"
    assert host(listing)["active"] is True
    assert host(listing)["state"] == "ready"


async def test_a_live_cluster_is_where_runs_go(compute, slurm):
    created = await compute.create(PRESET, None)
    assert created["state"] == "queued"
    slurm.states[created["id"]] = Status("running", time_left=6125)
    listing = await fresh(compute)
    [cluster] = clusters(listing)
    assert cluster["active"] is True and host(listing)["active"] is False
    assert cluster["label"] == "Regular · 4 nodes · 2 h"
    assert cluster["timeLeft"] == 6125
    assert cluster["size"]["nodes"] == 4
    assert cluster["details"][0] == "Job 1"


async def test_an_engine_that_cannot_attach_keeps_runs_on_this_host(compute, monkeypatch):
    await compute.create(PRESET, None)
    monkeypatch.setattr(service, "engine_attaches", lambda: False)
    listing = await fresh(compute)
    assert listing["attaches"] is False
    assert host(listing)["active"] is True
    assert clusters(listing)[0]["active"] is False


async def test_an_allocation_comes_first(compute, monkeypatch):
    await compute.create(PRESET, None)
    monkeypatch.setenv("SLURM_JOB_ID", "31400011")
    monkeypatch.setenv("SLURM_JOB_NUM_NODES", "2")
    listing = await fresh(compute)
    assert host(listing)["variant"] == "allocation"
    assert host(listing)["size"]["nodes"] == 2
    assert host(listing)["active"] is True


async def test_a_login_node_is_for_checking_only(compute, monkeypatch):
    monkeypatch.setenv("NERSC_HOST", "perlmutter")
    local = FakeBackend("local")
    compute.backends["local"] = local
    listing = await fresh(compute)
    assert host(listing)["variant"] == "login"
    assert host(listing)["state"] == "check-only"
    assert host(listing)["problem"]["code"] == "login-node"
    assert listing["backends"] == ["slurm"]
    with pytest.raises(PresetError, match="cannot start 'local'"):
        await compute.create({"backend": "local", "label": "Local"}, None)


async def test_a_hub_server_says_so(compute, monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_USER", "someone")
    assert host(await fresh(compute))["variant"] == "server"


async def test_two_candidates_are_refused_rather_than_guessed(compute, slurm, tmp_path):
    for _ in range(2):
        directory = records.make_directory(compute.root, records.new_cluster_id())
        records.write_record(
            records.Record(
                directory,
                {
                    "format": records.FORMAT,
                    "id": directory.name,
                    "backend": "slurm",
                    "label": "x",
                    "created": records.utc_now(),
                    "workers": records.worker_environment(),
                    "slurm": {"job": directory.name},
                },
            )
        )
    listing = await fresh(compute)
    assert host(listing)["active"] is True
    assert host(listing)["problem"]["code"] == "several-clusters"
    assert not any(cluster["active"] for cluster in clusters(listing))


async def test_a_cluster_of_another_engine_version_names_the_problem(compute):
    created = await compute.create(PRESET, None)
    path = compute.root / created["id"] / records.RECORD_FILE
    data = json.loads(path.read_text())
    data["workers"]["lightcone"] = "0.4.0"
    path.write_text(json.dumps(data))
    [cluster] = clusters(await fresh(compute))
    assert cluster["problem"]["code"] == "version"
    assert "0.4.0" in cluster["problem"]["message"]
    assert cluster["active"] is True


async def test_a_gone_cluster_is_forgotten_and_reported_once(compute, slurm):
    created = await compute.create(PRESET, None)
    slurm.states[created["id"]] = Status("gone", reason="reached its time limit")
    listing = await fresh(compute)
    assert clusters(listing) == []
    assert not (compute.root / created["id"]).exists()
    [ended] = listing["ended"]
    assert ended == {"id": created["id"], "backend": "slurm", "label": PRESET["label"], "reason": "reached its time limit", "at": ended["at"]}
    assert (await fresh(compute))["ended"] == [ended]


async def test_a_cluster_the_user_stopped_ends_quietly(compute, slurm):
    created = await compute.create(PRESET, None)
    await compute.stop(created["id"])
    assert slurm.stopped == [created["id"]]
    assert clusters(await fresh(compute))[0]["state"] == "stopping"
    slurm.states[created["id"]] = Status("gone", reason="was cancelled")
    listing = await fresh(compute)
    assert clusters(listing) == [] and listing["ended"] == []


async def test_an_unanswered_backend_forgets_nothing(compute, slurm):
    created = await compute.create(PRESET, None)
    slurm.states[created["id"]] = Status("unknown")
    [cluster] = clusters(await fresh(compute))
    assert cluster["state"] == "unknown"
    assert (compute.root / created["id"]).is_dir()


async def test_the_record_exists_before_the_backend_starts_anything(compute, slurm):
    created = await compute.create(PRESET, None)
    assert slurm.started == [(created["id"], {"nodes": 4}, True)]
    data = json.loads((compute.root / created["id"] / records.RECORD_FILE).read_text())
    assert data["format"] == records.FORMAT
    assert data["backend"] == "slurm"
    assert data["slurm"] == {"job": "1", "nodes": 4}
    assert data["tls"]["key"] == "tls/key.pem"
    assert data["workers"]["lightcone"] == records.package_version("lightcone-cli")


async def test_a_failed_start_leaves_no_record(compute, slurm):
    slurm.fail_start = "Slurm refused the cluster: Invalid qos specification"
    with pytest.raises(BackendError, match="Invalid qos"):
        await compute.create(PRESET, None)
    assert records.read_records(compute.root) == []


async def test_one_cluster_per_backend_at_a_time(compute):
    await compute.create(PRESET, None)
    with pytest.raises(ConflictError, match="already running"):
        await compute.create(PRESET, None)


@pytest.mark.parametrize(
    "preset, message",
    [
        (None, "preset object"),
        ({"backend": "pbs", "label": "x"}, "cannot start 'pbs'"),
        ({"backend": "slurm"}, "label"),
        ({"backend": "slurm", "label": "x" * 81}, "label"),
        ({"backend": "slurm", "label": "two\nlines"}, "label"),
        ({"backend": "slurm", "label": "x", "nodes": 0}, "nodes"),
    ],
)
async def test_presets_are_checked(compute, preset, message):
    with pytest.raises(PresetError, match=message):
        await compute.create(preset, None)


async def test_an_unavailable_backend_cannot_start(compute, slurm):
    slurm.is_available = False
    assert (await compute.listing(None))["backends"] == []
    with pytest.raises(PresetError):
        await compute.create(PRESET, None)


async def test_stopping_an_unknown_cluster(compute, slurm):
    with pytest.raises(KeyError):
        await compute.stop("20260101-000000-abcd")
    created = await compute.create(PRESET, None)
    slurm.fail_stop = "Slurm refused to cancel job 1"
    with pytest.raises(BackendError):
        await compute.stop(created["id"])
    assert clusters(await fresh(compute))[0]["state"] == "queued"


def write_bare_record(compute, created):
    """A record as the service writes it before the backend accepts the cluster."""
    directory = records.make_directory(compute.root, records.new_cluster_id())
    records.write_record(
        records.Record(
            directory,
            {"format": records.FORMAT, "id": directory.name, "backend": "slurm", "label": "x", "created": created, "workers": records.worker_environment()},
        )
    )
    return directory


async def test_a_start_in_progress_is_never_mistaken_for_a_dead_cluster(compute, slurm):
    slurm.default = Status("gone", reason="ended")
    directory = write_bare_record(compute, records.utc_now())
    [cluster] = clusters(await fresh(compute))
    assert cluster["state"] == "starting"
    assert directory.is_dir()


async def test_a_start_that_never_finished_is_dropped(compute, slurm):
    directory = write_bare_record(compute, "2020-01-01T00:00:00Z")
    listing = await fresh(compute)
    assert clusters(listing) == []
    assert not directory.exists()
    assert listing["ended"][0]["reason"] == "did not start"
