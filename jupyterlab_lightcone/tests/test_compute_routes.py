"""The Compute API: listing, starting and stopping clusters over HTTP."""

import json

import pytest
from tornado.httpclient import HTTPClientError

from jupyterlab_lightcone.compute import service as service_module
from jupyterlab_lightcone.compute.routes import SERVICE_SETTING
from jupyterlab_lightcone.compute.service import ComputeService

from .compute_fixtures import FakeBackend

ENDPOINT = ("jupyterlab_lightcone", "api", "compute")
PRESET = {"backend": "slurm", "label": "Debug · 1 node", "nodes": 1}


@pytest.fixture
def slurm():
    return FakeBackend("slurm")


@pytest.fixture
def app(jp_serverapp, tmp_path, slurm, monkeypatch):
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    monkeypatch.delenv("NERSC_HOST", raising=False)
    monkeypatch.setattr(service_module, "engine_attaches", lambda: True)
    jp_serverapp.web_app.settings[SERVICE_SETTING] = ComputeService(
        [slurm], base_url="/", idle_timeout=1800, root=tmp_path / "clusters"
    )
    return jp_serverapp


@pytest.fixture
def project(jp_root_dir):
    (jp_root_dir / "project").mkdir()
    (jp_root_dir / "project" / "astra.yaml").write_text("name: example\n")
    return "project/astra.yaml"


async def fails(fetch, code, match=None):
    with pytest.raises(HTTPClientError) as error:
        await fetch
    assert error.value.code == code
    if match:
        assert match in json.loads(error.value.response.body)["message"]


async def test_the_listing_needs_no_project(app, jp_fetch):
    response = await jp_fetch(*ENDPOINT)
    listing = json.loads(response.body)
    assert response.headers["Cache-Control"] == "no-store"
    assert listing["backends"] == ["slurm"]
    assert [target["id"] for target in listing["targets"]] == ["host"]


async def test_the_listing_takes_the_current_project(app, jp_fetch, project):
    listing = json.loads((await jp_fetch(*ENDPOINT, params={"path": project})).body)
    assert listing["targets"][0]["active"] is True
    await fails(jp_fetch(*ENDPOINT, params={"path": "missing/astra.yaml"}), 404)


async def test_starting_and_stopping_a_cluster(app, jp_fetch, slurm, project):
    response = await jp_fetch(*ENDPOINT, "clusters", method="POST", body=json.dumps({"preset": PRESET, "path": project}))
    assert response.code == 201
    cluster = json.loads(response.body)
    assert cluster["kind"] == "cluster" and cluster["state"] == "queued" and cluster["active"] is True
    await fails(jp_fetch(*ENDPOINT, "clusters", method="POST", body=json.dumps({"preset": PRESET})), 409, "already exists")
    response = await jp_fetch(*ENDPOINT, "clusters", cluster["id"], method="DELETE")
    assert response.code == 204
    assert slurm.stopped == [cluster["id"]]


@pytest.mark.parametrize(
    "body, message",
    [
        ([], "JSON body"),
        ({}, "preset object"),
        ({"preset": {"backend": "pbs", "label": "x"}}, "cannot start"),
        ({"preset": {**PRESET, "nodes": -1}}, "nodes"),
    ],
)
async def test_bad_requests_say_what_is_wrong(app, jp_fetch, body, message):
    await fails(jp_fetch(*ENDPOINT, "clusters", method="POST", body=json.dumps(body)), 400, message)


async def test_a_backend_refusal_is_a_bad_gateway(app, jp_fetch, slurm):
    slurm.fail_start = "Slurm refused the cluster: Invalid account"
    await fails(jp_fetch(*ENDPOINT, "clusters", method="POST", body=json.dumps({"preset": PRESET})), 502, "Invalid account")


async def test_stopping_an_unknown_cluster_is_not_found(app, jp_fetch):
    await fails(jp_fetch(*ENDPOINT, "clusters", "20260101-000000-abcd", method="DELETE"), 404)
