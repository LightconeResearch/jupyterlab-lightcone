"""Dask Gateway clusters, against a fake gateway client with the real one's surface."""

from dataclasses import dataclass, field
import enum
from types import SimpleNamespace

import dask.config
import pytest

from jupyterlab_lightcone.compute import gateway as gateway_module
from jupyterlab_lightcone.compute import records
from jupyterlab_lightcone.compute.backend import BackendError
from jupyterlab_lightcone.compute.gateway import MARKER, GatewayBackend
from jupyterlab_lightcone.compute.records import FORMAT, Record

ADDRESS = "http://traefik-lightcone-dask-gateway/services/dask-gateway"


class ClusterStatus(enum.IntEnum):
    PENDING = 1
    RUNNING = 2
    STOPPING = 3
    STOPPED = 4
    FAILED = 5


class Options(dict):
    """Like dask_gateway's Options: fixed fields, validated on assignment."""

    def __init__(self, fields, rejected=()):
        super().__init__(fields)
        self.rejected = rejected

    def __setitem__(self, key, value):
        if key not in self:
            raise KeyError(key)
        if key in self.rejected:
            raise ValueError(f"{key} must be at most 8")
        super().__setitem__(key, value)


@dataclass
class Hub:
    options: dict = field(default_factory=lambda: {"image": "default", "worker_cores": 1, "worker_memory": 2, "environment": {"TZ": "UTC"}})
    rejected: tuple = ()
    reports: list = field(default_factory=list)
    endings: dict = field(default_factory=dict)
    down: bool = False
    submitted: list = field(default_factory=list)
    adapted: list = field(default_factory=list)
    stopped: list = field(default_factory=list)
    opened: int = 0
    closed: int = 0


class FakeGateway:
    def __init__(self, hub: Hub, address=ADDRESS):
        self.hub = hub
        self.address = address
        hub.opened += 1

    async def cluster_options(self):
        return Options(self.hub.options, self.hub.rejected)

    async def submit(self, options):
        self.hub.submitted.append(dict(options))
        return "lightcone.0123abcd"

    async def adapt_cluster(self, name, minimum=None, maximum=None):
        self.hub.adapted.append((name, minimum, maximum))

    async def list_clusters(self):
        if self.hub.down:
            raise OSError("gateway unreachable")
        return self.hub.reports

    async def get_cluster(self, name):
        return SimpleNamespace(name=name, status=self.hub.endings[name])

    async def stop_cluster(self, name):
        if self.hub.down:
            raise OSError("gateway unreachable")
        self.hub.stopped.append(name)

    async def close(self):
        self.hub.closed += 1


@pytest.fixture
def hub():
    return Hub()


@pytest.fixture
def backend(hub):
    return GatewayBackend(lambda: FakeGateway(hub))


def make_record(tmp_path, **extra) -> Record:
    cluster_id = records.new_cluster_id()
    directory = records.make_directory(tmp_path / "clusters", cluster_id)
    return Record(
        directory,
        {"format": FORMAT, "id": cluster_id, "backend": "gateway", "label": "Medium", "tls": None, "workers": records.worker_environment(interpreter=None), **extra},
    )


def report(name, status, dashboard=None):
    return SimpleNamespace(name=name, status=status, dashboard_link=dashboard)


async def test_a_cluster_runs_this_servers_image_and_adapts(tmp_path, backend, hub, monkeypatch):
    monkeypatch.setenv("JUPYTER_IMAGE_SPEC", "ghcr.io/lightconeresearch/lightcone-hub/user:sha-3f9c1e2")
    record = make_record(tmp_path)
    await backend.start(record, {"workers": 6, "cores": 2, "memory": 4.0})
    [submitted] = hub.submitted
    assert submitted["image"] == "ghcr.io/lightconeresearch/lightcone-hub/user:sha-3f9c1e2"
    assert submitted["worker_cores"] == 2 and submitted["worker_memory"] == 4.0
    assert submitted["environment"] == {"TZ": "UTC", MARKER: record.id}
    assert hub.adapted == [("lightcone.0123abcd", 1, 6)]
    assert record.data["gateway"] == {"name": "lightcone.0123abcd", "address": ADDRESS, "workers": 6, "cores": 2, "memory": 4.0}
    assert record.data["workers"]["image"] == "ghcr.io/lightconeresearch/lightcone-hub/user:sha-3f9c1e2"
    assert hub.closed == hub.opened == 1


async def test_without_an_image_option_the_record_says_which_image_runs(tmp_path, backend, hub, monkeypatch):
    monkeypatch.delenv("JUPYTER_IMAGE_SPEC", raising=False)
    monkeypatch.delenv("JUPYTER_IMAGE", raising=False)
    record = make_record(tmp_path)
    await backend.start(record, {"workers": 2, "cores": None, "memory": None})
    assert record.data["workers"]["image"] == "default"
    assert "worker_cores" not in record.data["gateway"]


async def test_a_preset_the_gateway_cannot_honour_is_refused(tmp_path, backend, hub):
    hub.options = {"image": "default"}
    with pytest.raises(BackendError, match="no worker_cores option"):
        await backend.start(make_record(tmp_path), {"workers": 2, "cores": 2, "memory": None})
    hub.options = {"worker_cores": 1}
    hub.rejected = ("worker_cores",)
    with pytest.raises(BackendError, match="rejected the preset: worker_cores must be at most 8"):
        await backend.start(make_record(tmp_path), {"workers": 2, "cores": 64, "memory": None})
    assert hub.submitted == []
    assert hub.closed == hub.opened


async def test_reports_decide_each_state(tmp_path, backend, hub):
    pending, running, stopping, gone, elsewhere = (
        make_record(tmp_path, gateway={"name": name, "address": address})
        for name, address in [("a", ADDRESS), ("b", ADDRESS), ("c", ADDRESS), ("d", ADDRESS), ("e", "http://another")]
    )
    hub.reports = [
        report("a", ClusterStatus.PENDING),
        report("b", ClusterStatus.RUNNING, "/services/dask-gateway/clusters/b/status"),
        report("c", ClusterStatus.STOPPING),
        report("e", ClusterStatus.RUNNING),
    ]
    hub.endings = {"d": ClusterStatus.STOPPED}
    statuses = await backend.statuses([pending, running, stopping, gone, elsewhere])
    assert statuses[pending.id].state == "starting"
    assert statuses[running.id].state == "running"
    assert statuses[running.id].dashboard == "/services/dask-gateway/clusters/b/status"
    assert statuses[stopping.id].state == "stopping"
    assert (statuses[gone.id].state, statuses[gone.id].reason) == ("gone", "was stopped")
    assert statuses[elsewhere.id].state == "unknown"


async def test_an_unreachable_gateway_forgets_nothing(tmp_path, backend, hub):
    hub.down = True
    record = make_record(tmp_path, gateway={"name": "a", "address": ADDRESS})
    assert (await backend.statuses([record]))[record.id].state == "unknown"


async def test_stop_asks_the_gateway(tmp_path, backend, hub):
    record = make_record(tmp_path, gateway={"name": "a", "address": ADDRESS})
    await backend.stop(record)
    assert hub.stopped == ["a"]
    hub.down = True
    with pytest.raises(BackendError, match="could not stop"):
        await backend.stop(record)


def test_it_needs_the_client_and_a_configured_gateway(monkeypatch):
    backend = GatewayBackend()
    monkeypatch.setattr(gateway_module.importlib.util, "find_spec", lambda name: None)
    assert not backend.available()
    monkeypatch.setattr(gateway_module.importlib.util, "find_spec", lambda name: object())
    with dask.config.set({"gateway.address": None}):
        assert not backend.available()
    with dask.config.set({"gateway.address": ADDRESS}):
        assert backend.available()


def test_a_preset_names_workers_cores_and_memory(backend):
    assert backend.validate({}) == {"workers": 2, "cores": None, "memory": None}
    assert backend.validate({"workers": 8, "cores": 8, "memory": 16}) == {"workers": 8, "cores": 8, "memory": 16}
    for bad in ({"workers": 0}, {"cores": "2"}, {"memory": -1}):
        with pytest.raises(ValueError):
            backend.validate(bad)
