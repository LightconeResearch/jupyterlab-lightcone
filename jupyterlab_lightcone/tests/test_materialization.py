"""Status pass-through, a fixed read-only CLI command, and the authenticated endpoint."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import materialization

ENDPOINT = ('jupyterlab_lightcone', 'api', 'materialization')


def test_status_command_and_states(tmp_path, monkeypatch):
    rows = [
        dict(output='baseline/a', status='current', why=''),
        dict(output='baseline/b', status='behind', why='earlier environment'),
        dict(output='baseline/c', status='stale', why='input changed'),
        dict(output='baseline/d', status='stale', why='no manifest'),
    ]
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'outputs': rows})))
    monkeypatch.setattr(materialization.shutil, 'which', lambda name: '/tools/lc')
    monkeypatch.setattr(materialization.subprocess, 'run', run)
    report = materialization.read_status(tmp_path)['outputs']
    assert [item['state'] for item in report.values()] == ['current', 'behind', 'stale', 'stale']
    assert report['baseline/b']['detail'] == 'earlier environment'
    assert run.call_args.args == (['/tools/lc', 'status', '--json'],)
    assert run.call_args.kwargs['cwd'] == tmp_path
    assert run.call_args.kwargs['timeout'] == 30
    assert not run.call_args.kwargs.get('shell')


def test_cli_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(materialization.shutil, 'which', lambda name: None)
    with pytest.raises(HTTPError, match='not installed'):
        materialization.read_status(tmp_path)


@pytest.mark.parametrize('stdout', ['null', '{}', '{"outputs": {}}', '{"outputs": [{"status": "new-state"}]}'])
def test_invalid_report_is_not_an_empty_success(tmp_path, monkeypatch, stdout):
    monkeypatch.setattr(materialization.shutil, 'which', lambda name: '/tools/lc')
    monkeypatch.setattr(materialization.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=stdout))
    with pytest.raises(HTTPError, match='unsupported'):
        materialization.read_status(tmp_path)


@pytest.mark.parametrize('path', ['../astra.yaml', '/astra.yaml', 'drive:astra.yaml', 'other.yaml'])
def test_rejects_nonlocal_project_paths(tmp_path, path):
    with pytest.raises(HTTPError):
        materialization.project_root(tmp_path, path)


def test_rejects_outside_symlink(tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    (root / 'outside').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(HTTPError):
        materialization.project_root(root, 'outside/astra.yaml')


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


@pytest.mark.parametrize('failure', ['timeout', 'exit'])
def test_cli_failures_are_unavailable(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(materialization.shutil, 'which', lambda name: '/tools/lc')
    run = Mock(return_value=SimpleNamespace(returncode=1, stdout=''))
    if failure == 'timeout':
        run.side_effect = materialization.subprocess.TimeoutExpired('lc', 30)
    monkeypatch.setattr(materialization.subprocess, 'run', run)
    with pytest.raises(HTTPError) as raised:
        materialization.read_status(tmp_path)
    assert raised.value.status_code == (504 if failure == 'timeout' else 503)
