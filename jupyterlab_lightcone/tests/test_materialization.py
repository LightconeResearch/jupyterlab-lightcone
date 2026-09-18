"""Status pass-through from the Lightcone engine, and the authenticated endpoint."""
import json
from unittest.mock import Mock

from lightcone.engine.materialize import OutputStatus, StatusReport
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import materialization, projects

ENDPOINT = ('jupyterlab_lightcone', 'api', 'materialization')


def test_status_passes_the_engines_states_through(tmp_path, monkeypatch):
    rows = [
        ('baseline/a', 'current', ''),
        ('baseline/b', 'behind', 'earlier environment'),
        ('baseline/c', 'stale', 'input changed'),
    ]
    outputs = [OutputStatus(output, state, why, git_sha='', data_version='') for output, state, why in rows]
    engine = Mock(return_value=StatusReport(outputs=outputs))
    monkeypatch.setattr(materialization, 'current_project', lambda directory: directory)
    monkeypatch.setattr(materialization, 'status', engine)
    report = materialization.read_status(tmp_path)['outputs']
    assert [item['state'] for item in report.values()] == ['current', 'behind', 'stale']
    assert report['baseline/b']['detail'] == 'earlier environment'
    engine.assert_called_once_with(tmp_path)


def test_a_folder_the_engine_cannot_read_is_unavailable(tmp_path):
    with pytest.raises(HTTPError) as raised:
        materialization.read_status(tmp_path)
    assert raised.value.status_code == 503


@pytest.mark.parametrize('path', ['../astra.yaml', '/astra.yaml', 'drive:astra.yaml', 'other.yaml'])
def test_rejects_nonlocal_project_paths(tmp_path, path):
    with pytest.raises(HTTPError):
        projects.project_root(tmp_path, path)


def test_rejects_outside_symlink(tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    (root / 'outside').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(HTTPError):
        projects.project_root(root, 'outside/astra.yaml')


async def test_status_endpoint(jp_fetch, jp_serverapp, monkeypatch):
    root = materialization.Path(jp_serverapp.contents_manager.root_dir)
    (root / 'astra.yaml').write_text('version: 0.0.14\n')
    read = Mock(return_value={'outputs': {'baseline/a': {'state': 'current', 'detail': ''}}})
    monkeypatch.setattr(materialization, 'read_status', read)
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml'})
    assert response.code == 200
    assert json.loads(response.body)['outputs']['baseline/a']['state'] == 'current'
    read.assert_called_once_with(root.resolve())
    assert response.headers['Cache-Control'] == 'no-store'


async def test_requires_authentication(jp_fetch):
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml'}, follow_redirects=False, headers={'Authorization': ''}, raise_error=False)
    assert response.code in (302, 403)


async def test_requires_read_authorization(jp_fetch, jp_serverapp, monkeypatch):
    authorize = Mock(return_value=False)
    monkeypatch.setattr(jp_serverapp.authorizer, 'is_authorized', authorize)
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml'}, raise_error=False)
    assert response.code == 403
    assert authorize.call_args.args[2:] == ('read', 'contents')
