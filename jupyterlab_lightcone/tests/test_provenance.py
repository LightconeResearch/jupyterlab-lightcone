"""Only authenticated, bounded reads of identified Lightcone run records."""
import json

import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import provenance

ENDPOINT = ('jupyterlab_lightcone', 'api', 'provenance')


def manifest(root, **changes):
    record = dict(schema_version=1, universe_id='baseline', output_id='fit', finished_at='2026-09-15T10:00:00Z', git_sha='a' * 40, recipe='python fit.py', env_version='sha256:env', lc_version='0.5', input_versions={'data': 'sha256:input'})
    record.update(changes)
    path = provenance.record_path(root, 'baseline', 'fit')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))
    return path, record


def test_read_record_and_absent_record(tmp_path):
    path, record = manifest(tmp_path)
    assert provenance.read_record(path, 'baseline', 'fit') == {'record': record}
    path.unlink()
    assert provenance.read_record(path, 'baseline', 'fit') == {'record': None}


@pytest.mark.parametrize('changes', [{'schema_version': 2}, {'output_id': 'other'}, {'universe_id': 'other'}, {'input_versions': []}, {'input_versions': {'a': {}}}, {'git_sha': None}])
def test_rejects_unsupported_record(tmp_path, changes):
    """A record this server cannot use is a 500, the code the comment store gets for the same failure."""
    path, _ = manifest(tmp_path, **changes)
    with pytest.raises(HTTPError, match='unsupported') as raised:
        provenance.read_record(path, 'baseline', 'fit')
    assert raised.value.status_code == 500


@pytest.mark.parametrize('universe, output', [('../outside', 'fit'), ('/outside', 'fit'), ('baseline', '../fit'), ('baseline', 'fit.json'), ('.hidden', 'fit'), ('baseline', 'a\\b'), ('baseline', ''), ('', 'fit'), ('base\x00line', 'fit')])
def test_rejects_arbitrary_paths(tmp_path, universe, output):
    with pytest.raises(HTTPError) as raised:
        provenance.validate_output_identity(universe, output)
    assert raised.value.status_code == 400
    with pytest.raises(HTTPError):
        provenance.record_path(tmp_path, universe, output)


def test_the_record_path_follows_the_engines_layout(tmp_path):
    assert provenance.record_path(tmp_path, 'base.line', 'fit') == tmp_path.resolve() / 'results' / 'base.line' / '.fit.manifest.json'


def test_rejects_symlink_escape(tmp_path):
    project = tmp_path / 'project'
    project.mkdir()
    (project / 'results').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(HTTPError, match='outside'):
        provenance.record_path(project, 'baseline', 'fit')


def test_bounds_record_and_rejects_invalid_json(tmp_path, monkeypatch):
    path, _ = manifest(tmp_path)
    monkeypatch.setattr(provenance, 'MAX_RECORD_BYTES', 16)
    with pytest.raises(HTTPError, match='unsupported'):
        provenance.read_record(path, 'baseline', 'fit')
    path.write_bytes(b'\xff')
    with pytest.raises(HTTPError, match='unsupported'):
        provenance.read_record(path, 'baseline', 'fit')


async def test_authenticated_record_endpoint(jp_fetch, jp_serverapp):
    root = provenance.Path(jp_serverapp.contents_manager.root_dir)
    (root / 'astra.yaml').write_text('version: 0.0.14\n')
    _, record = manifest(root)
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml', 'universe': 'baseline', 'output': 'fit'})
    assert response.code == 200
    assert json.loads(response.body) == {'record': record}
    assert response.headers['Cache-Control'] == 'no-store'
    assert not jp_serverapp.contents_manager.allow_hidden


async def test_requires_authentication(jp_fetch):
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml'}, follow_redirects=False, headers={'Authorization': ''}, raise_error=False)
    assert response.code in (302, 403)


async def test_requires_contents_authorization(jp_fetch, jp_serverapp, monkeypatch):
    monkeypatch.setattr(jp_serverapp.authorizer, 'is_authorized', lambda *args, **kwargs: False)
    response = await jp_fetch(*ENDPOINT, params={'path': 'astra.yaml'}, raise_error=False)
    assert response.code == 403
