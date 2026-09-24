"""Output versions come from real git and git-annex history, read in process and never written."""
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import Mock

import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import annex, versions
from jupyterlab_lightcone.projects import expose_engine_tools

ENDPOINT = ('jupyterlab_lightcone', 'api', 'versions')
CONTENT = (*ENDPOINT, 'content')
RESULTS_ROUTE = (*ENDPOINT, 'results')
SOURCE = (*ENDPOINT, 'source')
PACKAGES = (*ENDPOINT, 'packages')
RESULTS = Path('results', 'baseline')


@pytest.fixture(autouse=True)
def engine_tools():
    """`git annex` must find the git-annex installed beside the engine, as it does in the server."""
    expose_engine_tools()


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return '/user/researcher/'


def registered(web_app, handler):
    return any(rule.target is handler for host in web_app.wildcard_router.rules for rule in getattr(host.target, 'rules', []))


@pytest.fixture
def jp_serverapp(jp_serverapp):
    """The versions routes, registered as `application.py` registers them; a no-op once it does."""
    if not registered(jp_serverapp.web_app, versions.OutputVersionsHandler):
        versions.setup_versions_handlers(jp_serverapp.web_app)
    return jp_serverapp


def git(root, *args, env=None):
    return subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, check=True, env=env).stdout


def manifest(output='fig', **changes):
    record = dict(schema_version=1, universe_id='baseline', output_id=output, finished_at='2026-09-15T10:00:00Z', git_sha='a' * 40, recipe=f'python {output}.py', env_version='sha256:env', lc_version='0.5', input_versions={'data': 'sha256:input'})
    record.update(changes)
    return record


ATTRIBUTES = """* annex.largefiles=nothing
* filter=annex
results/** annex.largefiles=anything
results/**/.*.manifest.json annex.largefiles=nothing
"""
"""The engine's storage policy: outputs go to the annex, manifests and everything else stay in git."""


def init_repo(root, *options, annexed=True):
    """A repository with a first commit, as `lc init` leaves one: git, and an annex with the storage policy."""
    root.mkdir(parents=True, exist_ok=True)
    git(root, 'init', '-q', *options)
    git(root, 'config', 'user.name', 'Researcher')
    git(root, 'config', 'user.email', 'researcher@example.org')
    if annexed:
        git(root, 'annex', 'init', '-q', 'test repository')
        (root / '.gitattributes').write_text(ATTRIBUTES)
    (root / 'astra.yaml').write_text('version: 0.0.14\n')
    git(root, 'add', '-A', '--', '.')
    git(root, 'commit', '-q', '-m', 'Initial project')
    return root


def commit_all(root, message, when=None):
    """Stage everything under the project and commit it, as the engine adds; `when` sets the commit time in seconds."""
    git(root, '-c', 'annex.thin=true', '-c', 'annex.dotfiles=true', 'add', '-A', '--', '.')
    env = dict(os.environ)
    if when is not None:
        env['GIT_AUTHOR_DATE'] = env['GIT_COMMITTER_DATE'] = f'{int(when)} +0000'
    git(root, '-c', 'annex.thin=true', '-c', 'annex.dotfiles=true', 'commit', '-q', '--allow-empty', '-m', message, env=env)
    return git(root, 'rev-parse', 'HEAD').strip()


def materialize(root, content, message=None, record=None, output='fig', extension='png', when=None):
    """Write an output and commit it the way one engine run does: the bytes to the annex, a manifest beside it.

    The worker removes the previous output before rebuilding; overwriting it
    in place would rewrite the previous annex object through the thin hard link.
    """
    directory = root / RESULTS
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / f'{output}.{extension}'
    file.unlink(missing_ok=True)
    file.write_bytes(content)
    (directory / f'.{output}.manifest.json').write_text(json.dumps(manifest(output) if record is None else record))
    return commit_all(root, message or f'[DATALAD RUNCMD] {output} [baseline]', when)


def key_of(root, commit, file='results/baseline/fig.png'):
    return git(root, 'annex', 'lookupkey', '--ref', f'{commit}:{file}').strip()


def drop(root, key):
    git(root, 'annex', 'dropkey', '--force', key)


@pytest.fixture
def project(tmp_path):
    """Two engine materializations of `fig`; returns the root and the commits, newest first."""
    root = init_repo(tmp_path / 'project')
    first = materialize(root, b'\x89PNG one', when=1_700_000_000)
    second = materialize(root, b'\x89PNG two', when=1_700_000_100)
    return root, [second, first]


def test_lists_engine_versions_newest_first(project):
    root, (second, first) = project
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert listing['file'] == 'results/baseline/fig.png'
    assert listing['annex'] == 'initialized'
    assert [version['commit'] for version in listing['versions']] == [second, first]
    newest, oldest = listing['versions']
    assert newest['short'] == second[:7]
    assert newest['subject'] == '[DATALAD RUNCMD] fig [baseline]'
    assert datetime.fromisoformat(newest['time']).timestamp() == 1_700_000_100
    assert newest['manifest'] == manifest()
    assert newest['annex'] == {'key': key_of(root, second), 'here': True, 'remotes': []}
    assert (newest['size'], newest['present']) == (8, True)
    assert (oldest['size'], oldest['present'], oldest['annex']['key']) == (8, True, key_of(root, first))
    assert oldest['annex']['key'] != newest['annex']['key']
    assert set(newest) == {'commit', 'short', 'time', 'subject', 'size', 'present', 'annex', 'manifest'}


def test_reads_the_annexed_bytes_at_each_commit_by_full_or_short_name(project):
    root, (second, first) = project
    assert versions.read_version(root, 'baseline', 'fig', first) == ('results/baseline/fig.png', b'\x89PNG one')
    assert versions.read_version(root, 'baseline', 'fig', second[:7]) == ('results/baseline/fig.png', b'\x89PNG two')


def test_dropped_content_is_absent_but_still_listed(project):
    root, (_, first) = project
    old_key = key_of(root, first)
    drop(root, old_key)
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [version['present'] for version in listing['versions']] == [True, False]
    assert listing['versions'][1]['annex'] == {'key': old_key, 'here': False, 'remotes': []}
    assert listing['versions'][1]['size'] == 8
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', first)
    assert (raised.value.status_code, raised.value.reason) == (404, 'absent')
    assert 'not in this repository' in raised.value.log_message


def test_absent_bytes_name_the_repositories_that_hold_them(project, tmp_path):
    """A clone git-annex initialized knows where the origin keeps each key."""
    root, (second, first) = project
    # git-annex journals its location log and commits it to the git-annex branch on merge.
    git(root, 'annex', 'merge')
    clone = tmp_path / 'clone'
    git(tmp_path, 'clone', '-q', str(root), str(clone))
    git(clone, 'annex', 'init', '-q', 'laptop')
    listing = versions.list_versions(clone, 'baseline', 'fig')
    assert listing['annex'] == 'initialized'
    assert [(version['present'], version['annex']['remotes']) for version in listing['versions']] == [(False, ['test repository [origin]'])] * 2
    with pytest.raises(HTTPError) as raised:
        versions.read_version(clone, 'baseline', 'fig', second)
    assert raised.value.reason == 'absent'
    assert 'test repository [origin] has a copy (git annex get)' in raised.value.log_message
    git(clone, 'annex', 'get', '-q', 'results/baseline/fig.png')
    assert versions.read_version(clone, 'baseline', 'fig', second)[1] == b'\x89PNG two'


def test_an_uninitialized_clone_is_never_asked(project, tmp_path):
    """Any git-annex command would initialize a fresh clone; a read must not write to it."""
    root, (second, first) = project
    clone = tmp_path / 'clone'
    git(tmp_path, 'clone', '-q', str(root), str(clone))
    listing = versions.list_versions(clone, 'baseline', 'fig')
    assert listing['annex'] == 'uninitialized'
    assert [(version['commit'], version['present'], version['annex']) for version in listing['versions']] == [(second, False, None), (first, False, None)]
    with pytest.raises(HTTPError) as raised:
        versions.read_version(clone, 'baseline', 'fig', second)
    assert raised.value.reason == 'absent'
    assert 'git annex init' in raised.value.log_message
    assert subprocess.run(['git', 'config', '--get', 'annex.uuid'], cwd=clone, capture_output=True).returncode == 1
    assert not (clone / '.git' / 'annex').exists()


def test_a_locked_version_reads_like_an_unlocked_one(project):
    """A researcher may lock an annexed file: the commit then holds a symlink into the object store."""
    root, (second, _) = project
    git(root, 'annex', 'lock', '--force', 'results/baseline/fig.png')
    git(root, 'commit', '-q', '-m', 'Lock the figure')
    locked, unlocked, _ = versions.list_versions(root, 'baseline', 'fig')['versions']
    assert locked['subject'] == 'Lock the figure'
    assert unlocked['commit'] == second
    assert (locked['annex']['key'], locked['size'], locked['present']) == (unlocked['annex']['key'], 8, True)
    assert versions.read_version(root, 'baseline', 'fig', locked['commit'])[1] == b'\x89PNG two'


def test_a_repository_without_an_annex_keeps_its_bytes_in_git(tmp_path):
    root = init_repo(tmp_path / 'plain', annexed=False)
    first = materialize(root, b'a,b\n1,2\n', output='table', extension='csv')
    second = materialize(root, b'a,b\n3,4\n', output='table', extension='csv')
    listing = versions.list_versions(root, 'baseline', 'table')
    assert (listing['file'], listing['annex']) == ('results/baseline/table.csv', 'none')
    assert [(version['commit'], version['size'], version['present'], version['annex']) for version in listing['versions']] == [(second, 8, True, None), (first, 8, True, None)]
    assert versions.read_version(root, 'baseline', 'table', first) == ('results/baseline/table.csv', b'a,b\n1,2\n')
    assert versions.read_version(root, 'baseline', 'table', second[:7]) == ('results/baseline/table.csv', b'a,b\n3,4\n')


def test_a_file_the_policy_keeps_in_git_is_served_from_git(project):
    """Manifests, and anything outside `results/`, stay in git even in an annexed repository."""
    root, (second, _) = project
    (root / RESULTS / 'note.txt').write_text('kept in git')
    (root / '.gitattributes').write_text(ATTRIBUTES + 'results/**/note.txt annex.largefiles=nothing\n')
    commit = commit_all(root, 'Add a note')
    [version] = versions.list_versions(root, 'baseline', 'note')['versions']
    assert (version['commit'], version['size'], version['present'], version['annex']) == (commit, 11, True, None)
    assert versions.read_version(root, 'baseline', 'note', commit)[1] == b'kept in git'


def test_a_hand_edit_between_runs_is_a_version_too(project):
    root, _ = project
    commit = materialize(root, b'\x89PNG edited', 'Touch up the figure by hand')
    newest = versions.list_versions(root, 'baseline', 'fig')['versions'][0]
    assert (newest['commit'], newest['subject'], newest['manifest']) == (commit, 'Touch up the figure by hand', manifest())


def test_a_manifest_failing_the_provenance_checks_is_null(project):
    root, _ = project
    commit = materialize(root, b'\x89PNG three', record=manifest(output_id='other'))
    newest = versions.list_versions(root, 'baseline', 'fig')['versions'][0]
    assert (newest['commit'], newest['manifest']) == (commit, None)


def test_a_sha256_repository_serves_every_commit_it_lists(tmp_path):
    root = init_repo(tmp_path / 'plain', '--object-format=sha256', annexed=False)
    commit = materialize(root, b'a,b\n1,2\n', output='table', extension='csv')
    [version] = versions.list_versions(root, 'baseline', 'table')['versions']
    assert (version['commit'], len(commit)) == (commit, 64)
    assert versions.read_version(root, 'baseline', 'table', commit)[1] == b'a,b\n1,2\n'


def test_a_version_where_the_file_was_deleted_has_no_bytes(project):
    root, (second, _) = project
    (root / RESULTS / 'fig.png').unlink()
    commit_all(root, 'Remove the figure')
    # Neither the working tree nor the last commit has a file to name the format by.
    with pytest.raises(HTTPError) as raised:
        versions.list_versions(root, 'baseline', 'fig')
    assert raised.value.status_code == 404
    (root / RESULTS / 'fig.png').write_bytes(b'\x89PNG again')
    commit_all(root, 'Restore the figure')
    listing = versions.list_versions(root, 'baseline', 'fig')
    removed = next(version for version in listing['versions'] if version['subject'] == 'Remove the figure')
    assert (removed['size'], removed['present'], removed['annex'], removed['manifest']) == (None, False, None, manifest())
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', removed['commit'])
    assert raised.value.reason == 'missing'
    assert versions.read_version(root, 'baseline', 'fig', listing['versions'][0]['commit'])[1] == b'\x89PNG again'


def test_the_history_stays_readable_while_a_run_rebuilds_the_output(project):
    """The engine deletes the output and its manifest before rebuilding; the last commit still names it."""
    root, (second, first) = project
    (root / RESULTS / 'fig.png').unlink()
    (root / RESULTS / '.fig.manifest.json').unlink()
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert listing['file'] == 'results/baseline/fig.png'
    assert [version['commit'] for version in listing['versions']] == [second, first]


def test_a_renamed_output_keeps_its_history(tmp_path):
    root = init_repo(tmp_path / 'plain', annexed=False)
    first = materialize(root, b'a,b\n1,2\n', output='table', extension='csv')
    git(root, 'mv', 'results/baseline/table.csv', 'results/baseline/table.tsv')
    (root / RESULTS / '.table.manifest.json').write_text(json.dumps(manifest('table', output_path='results/baseline/table.tsv')))
    renamed = commit_all(root, 'Re-declare the format')
    listing = versions.list_versions(root, 'baseline', 'table')
    assert listing['file'] == 'results/baseline/table.tsv'
    assert [version['commit'] for version in listing['versions']] == [renamed, first]


def test_a_project_below_the_repository_root_reads_its_own_paths(tmp_path):
    repository = init_repo(tmp_path / 'repository')
    root = repository / 'analysis'
    (root / RESULTS).mkdir(parents=True)
    # The storage policy is relative to where it is written; the project carries its own.
    (root / '.gitattributes').write_text(ATTRIBUTES)
    commit = materialize(root, b'x,y\n', output='table', extension='csv')
    listing = versions.list_versions(root, 'baseline', 'table')
    [version] = listing['versions']
    assert (version['commit'], version['present'], version['annex']['key']) == (commit, True, key_of(root, commit, 'analysis/results/baseline/table.csv'))
    assert versions.read_version(root, 'baseline', 'table', commit)[1] == b'x,y\n'
    assert versions.results_commits(root)[0]['outputs'] == [{'universe': 'baseline', 'output': 'table'}]


def test_prefers_the_file_the_manifest_names_when_several_remain(project):
    root, _ = project
    (root / RESULTS / 'fig.svg').write_text('<svg/>')
    assert versions.output_file(root, 'baseline', 'fig', None)[0] == 'results/baseline/fig.png'
    (root / RESULTS / '.fig.manifest.json').write_text(json.dumps(manifest(output_path='results/baseline/fig.svg')))
    assert versions.output_file(root, 'baseline', 'fig', None) == ('results/baseline/fig.svg', 'results/baseline/.fig.manifest.json')


def test_an_output_without_a_file_is_not_found(project):
    root, _ = project
    for universe, output in [('baseline', 'never'), ('other', 'fig')]:
        with pytest.raises(HTTPError) as raised:
            versions.list_versions(root, universe, output)
        assert raised.value.status_code == 404


def test_a_folder_without_git_has_no_history(tmp_path):
    (tmp_path / RESULTS).mkdir(parents=True)
    (tmp_path / RESULTS / 'fig.png').write_bytes(b'\x89PNG')
    assert versions.list_versions(tmp_path, 'baseline', 'fig') == {'file': 'results/baseline/fig.png', 'annex': 'none', 'versions': []}
    assert versions.results_commits(tmp_path) == []
    with pytest.raises(HTTPError) as raised:
        versions.read_version(tmp_path, 'baseline', 'fig', 'a' * 40)
    assert raised.value.reason == 'repository'


def test_a_repository_before_its_first_commit_has_no_history(tmp_path):
    root = tmp_path / 'unborn'
    root.mkdir()
    git(root, 'init', '-q')
    (root / RESULTS).mkdir(parents=True)
    (root / RESULTS / 'fig.png').write_bytes(b'\x89PNG')
    assert versions.list_versions(root, 'baseline', 'fig')['versions'] == []
    assert versions.results_commits(root) == []


def test_an_uncommitted_output_has_no_history(project):
    root, _ = project
    (root / RESULTS / 'new.json').write_text('{}')
    assert versions.list_versions(root, 'baseline', 'new')['versions'] == []


def test_caps_the_history(project, monkeypatch):
    root, (second, _) = project
    monkeypatch.setattr(versions, 'MAX_VERSIONS', 1)
    assert [version['commit'] for version in versions.list_versions(root, 'baseline', 'fig')['versions']] == [second]


@pytest.mark.parametrize('universe, output', [('../outside', 'fig'), ('/outside', 'fig'), ('baseline', '../fig'), ('baseline', 'fig.png'), ('.hidden', 'fig'), ('baseline', 'a\\b'), ('baseline', '')])
def test_rejects_arbitrary_identities(project, universe, output):
    root, (second, _) = project
    with pytest.raises(HTTPError):
        versions.list_versions(root, universe, output)
    with pytest.raises(HTTPError):
        versions.read_version(root, universe, output, second)


@pytest.mark.parametrize('commit', ['HEAD', 'abc', 'g' * 7, '0' * 41, '0' * 63, '0' * 65, 'main..HEAD', '-'])
def test_rejects_malformed_commit_names(project, commit):
    root, _ = project
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', commit)
    assert raised.value.status_code == 400


def test_an_unknown_or_ambiguous_commit_is_not_found(project):
    root, (second, first) = project
    for commit in ['0' * 40, '0' * 7]:
        with pytest.raises(HTTPError) as raised:
            versions.read_version(root, 'baseline', 'fig', commit)
        assert (raised.value.status_code, raised.value.reason) == (404, 'commit')
    # A prefix shared by a commit and its own tree is still one commit.
    assert versions.read_source(root, first[:7], 'astra.yaml')['commit'] == first


def test_refuses_oversized_content(project, tmp_path, monkeypatch):
    root, (second, _) = project
    monkeypatch.setattr(versions, 'MAX_CONTENT_BYTES', 4)
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', second)
    assert raised.value.status_code == 413
    assert raised.value.log_message == 'This version is larger than the 4 bytes the viewer serves'
    plain = init_repo(tmp_path / 'plain', annexed=False)
    commit = materialize(plain, b'x' * 8, output='big', extension='txt')
    with pytest.raises(HTTPError) as raised:
        versions.read_version(plain, 'baseline', 'big', commit)
    assert raised.value.status_code == 413


def test_the_refusal_names_the_default_limit():
    assert versions.too_large().log_message == 'This version is larger than the 50 MiB the viewer serves'


def test_git_annex_answers_the_three_questions(project):
    """Keys, sizes and places come from git-annex's own commands, never from a parse of ours."""
    root, (second, first) = project
    refs = [f'{second}:results/baseline/fig.png', f'{first}:results/baseline/fig.png', f'{second}:astra.yaml', f'{second}:missing.png']
    keys = annex.lookup_keys(root, refs)
    assert keys[refs[2]] is None and keys[refs[3]] is None
    assert keys[refs[0]] and keys[refs[1]] and keys[refs[0]] != keys[refs[1]]
    assert annex.sizes(root, [keys[refs[0]], 'SHA256E-s12--nope.png', 'WORM--noname']) == {keys[refs[0]]: 8, 'SHA256E-s12--nope.png': 12, 'WORM--noname': None}
    assert annex.whereis(root, [keys[refs[0]], 'SHA256E-s12--nope.png']) == {
        keys[refs[0]]: {'key': keys[refs[0]], 'here': True, 'remotes': []},
        'SHA256E-s12--nope.png': {'key': 'SHA256E-s12--nope.png', 'here': False, 'remotes': []},
    }
    assert annex.content_path(root, keys[refs[0]]).read_bytes() == b'\x89PNG two'
    assert annex.content_path(root, 'SHA256E-s12--nope.png') is None
    assert annex.lookup_keys(root, []) == {} and annex.whereis(root, []) == {} and annex.sizes(root, []) == {}
    with pytest.raises(ValueError):
        annex.lookup_keys(root, ['HEAD:a\nb'])


def test_a_missing_git_annex_is_a_service_error(project, monkeypatch):
    root, (second, _) = project
    monkeypatch.setenv('PATH', '/nowhere')
    with pytest.raises(annex.AnnexUnavailable):
        annex.lookup_keys(root, [f'{second}:results/baseline/fig.png'])


@pytest.mark.parametrize('name, expected', [
    ('fig.png', 'image/png'), ('photo.JPG', 'image/jpeg'), ('a.jpeg', 'image/jpeg'), ('a.svg', 'image/svg+xml'),
    ('fit.json', 'application/json'), ('t.csv', 'text/csv; charset=utf-8'), ('t.tsv', 'text/tab-separated-values; charset=utf-8'),
    ('n.txt', 'text/plain; charset=utf-8'), ('p.pdf', 'application/pdf'), ('g.npz', 'application/octet-stream'),
    ('a.parquet', 'application/octet-stream'), ('noext', 'application/octet-stream'),
])
def test_content_types_follow_the_extension(name, expected):
    assert versions.content_type(name) == expected


def test_manifests_failing_the_provenance_checks_are_null():
    assert versions.validate_manifest(json.dumps(manifest()).encode(), 'baseline', 'fig') == manifest()
    assert versions.validate_manifest(json.dumps(manifest()).encode(), 'baseline', 'other') is None
    assert versions.validate_manifest(b'\xff', 'baseline', 'fig') is None
    assert versions.validate_manifest(b'[' * 100_000, 'baseline', 'fig') is None


def test_content_disposition_names_the_file_safely():
    assert versions.content_disposition('fig.png') == 'inline; filename="fig.png"; filename*=UTF-8\'\'fig.png'
    assert versions.content_disposition('fi"g é.png') == 'inline; filename="fi_g _.png"; filename*=UTF-8\'\'fi%22g%20%C3%A9.png'


# --- commits touching results ------------------------------------------------


@pytest.mark.parametrize('path, expected', [
    (b'results/baseline/fig.png', ('baseline', 'fig')),
    (b'results/baseline/.fig.manifest.json', ('baseline', 'fig')),
    (b'results/baseline/table.tar.gz', ('baseline', 'table')),
    (b'results/README.md', None),
    (b'results/baseline/.hidden', None),
    (b'results/.dot/fig.png', None),
    (b'data/baseline/fig.png', None),
    (b'results/baseline/deep/fig.png', None),
])
def test_output_identities_follow_the_engines_layout(path, expected):
    assert versions.output_identity(path) == expected


def test_lists_the_commits_that_touched_results_with_their_outputs(project):
    root, (second, first) = project
    aside = materialize(root, b'{}', output='fit', extension='json', when=1_700_000_200)
    (root / 'notes.md').write_text('no result here\n')
    commit_all(root, 'Notes only', when=1_700_000_300)
    listed = versions.results_commits(root)
    assert [(entry['commit'], entry['outputs']) for entry in listed] == [
        (aside, [{'universe': 'baseline', 'output': 'fit'}]),
        (second, [{'universe': 'baseline', 'output': 'fig'}]),
        (first, [{'universe': 'baseline', 'output': 'fig'}]),
    ]
    assert listed[0]['short'] == aside[:7]
    assert datetime.fromisoformat(listed[0]['time']).timestamp() == 1_700_000_200
    assert versions.results_commits(root, since=1_700_000_050, until=1_700_000_150) == [listed[1]]
    assert versions.results_commits(root, limit=1) == [listed[0]]


async def test_versions_endpoint(jp_fetch, jp_serverapp):
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one')
    second = materialize(root, b'\x89PNG two')
    response = await jp_fetch(*ENDPOINT, params={'path': 'project/astra.yaml', 'universe': 'baseline', 'output': 'fig'})
    assert response.code == 200
    listing = json.loads(response.body)
    assert listing['file'] == 'results/baseline/fig.png'
    assert [version['commit'] for version in listing['versions']] == [second, first]
    assert response.headers['Cache-Control'] == 'no-store'
    assert not jp_serverapp.contents_manager.allow_hidden


async def test_content_endpoint(jp_fetch, jp_serverapp):
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one')
    materialize(root, b'\x89PNG two')
    response = await jp_fetch(*CONTENT, params={'path': 'project/astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': first})
    assert response.code == 200
    assert response.body == b'\x89PNG one'
    assert response.headers['Content-Type'] == 'image/png'
    assert response.headers['Content-Disposition'] == 'inline; filename="fig.png"; filename*=UTF-8\'\'fig.png'
    assert response.headers['Cache-Control'] == 'private, max-age=31536000, immutable'
    assert response.headers['X-Content-Type-Options'] == 'nosniff'


async def test_content_is_sandboxed_and_refuses_cross_site_inclusion(jp_fetch, jp_serverapp, monkeypatch):
    """Served as Jupyter serves `/files/`: scripts confined, and a cookie-only request vouched for by its Referer."""
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one')
    params = {'path': 'project/astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': first}
    response = await jp_fetch(*CONTENT, params=params)
    assert response.headers['Content-Security-Policy'].endswith('; sandbox allow-scripts')
    # A browser's <img> carries the session cookie and no token, so only its Referer vouches for it.
    monkeypatch.setattr(jp_serverapp.identity_provider, 'is_token_authenticated', lambda handler: False)
    for referer in ['https://elsewhere.example/page', None]:
        headers = {'Referer': referer} if referer else {}
        refused = await jp_fetch(*CONTENT, params=params, headers=headers, raise_error=False)
        assert refused.code == 403
    same_site = f'http://{urlsplit(response.effective_url).netloc}/lab'
    allowed = await jp_fetch(*CONTENT, params=params, headers={'Referer': same_site})
    assert allowed.body == b'\x89PNG one'


async def test_absent_content_is_a_distinguishable_404(jp_fetch, jp_serverapp):
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one')
    materialize(root, b'\x89PNG two')
    drop(root, key_of(root, first))
    params = {'path': 'project/astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': first}
    response = await jp_fetch(*CONTENT, params=params, raise_error=False)
    assert response.code == 404
    assert json.loads(response.body)['reason'] == 'absent'
    assert response.headers['Cache-Control'] == 'no-store'
    response = await jp_fetch(*CONTENT, params={**params, 'commit': 'nope'}, raise_error=False)
    assert response.code == 400


async def test_results_endpoint(jp_fetch, jp_serverapp):
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one', when=1_700_000_000)
    second = materialize(root, b'\x89PNG two', when=1_700_000_100)
    response = await jp_fetch(*RESULTS_ROUTE, params={'path': 'project/astra.yaml'})
    assert [entry['commit'] for entry in json.loads(response.body)['commits']] == [second, first]
    response = await jp_fetch(*RESULTS_ROUTE, params={'path': 'project/astra.yaml', 'since': '1700000050', 'until': '1700000150'})
    assert [entry['commit'] for entry in json.loads(response.body)['commits']] == [second]
    for params in [{'since': 'yesterday'}, {'limit': '0'}, {'limit': str(versions.MAX_RESULTS_COMMITS + 1)}]:
        refused = await jp_fetch(*RESULTS_ROUTE, params={'path': 'project/astra.yaml', **params}, raise_error=False)
        assert refused.code == 400


@pytest.mark.parametrize('endpoint', [ENDPOINT, CONTENT, RESULTS_ROUTE, SOURCE, PACKAGES])
async def test_requires_authentication(jp_fetch, endpoint):
    params = {'path': 'astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': 'a' * 7, 'file': 'fig.py'}
    response = await jp_fetch(*endpoint, params=params, follow_redirects=False, headers={'Authorization': ''}, raise_error=False)
    assert response.code in (302, 403)


@pytest.mark.parametrize('endpoint', [ENDPOINT, CONTENT, RESULTS_ROUTE, SOURCE, PACKAGES])
async def test_requires_read_authorization(jp_fetch, jp_serverapp, monkeypatch, endpoint):
    (Path(jp_serverapp.contents_manager.root_dir) / 'astra.yaml').write_text('version: 0.0.14\n')
    authorize = Mock(return_value=False)
    monkeypatch.setattr(jp_serverapp.authorizer, 'is_authorized', authorize)
    params = {'path': 'astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': 'a' * 7, 'file': 'fig.py'}
    response = await jp_fetch(*endpoint, params=params, raise_error=False)
    assert response.code == 403
    assert authorize.call_args.args[2:] == ('read', 'contents')


# --- the recorded revision: scripts and the locked environment ---------------

LOCK_V1 = b"""version = 1
requires-python = ">=3.11"

[[package]]
name = "numpy"
version = "2.1.0"

[[package]]
name = "my-project"
source = { editable = "." }

[[package]]
name = "astropy"
version = "6.0.0"
"""


def commit_files(root, files, message):
    """Commit plain files by hand; returns the commit."""
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    git(root, 'add', '--', *files)
    git(root, 'commit', '-q', '-m', message)
    return git(root, 'rev-parse', 'HEAD').strip()


def test_reads_a_script_as_a_revision_held_it(tmp_path):
    root = init_repo(tmp_path / 'project')
    before = commit_files(root, {'src/fig.py': b'print("one")\n'}, 'Add the script')
    commit_files(root, {'src/fig.py': b'print("two")\n'}, 'Change the script')
    answer = versions.read_source(root, before[:7], 'src/fig.py')
    assert answer == {
        'file': 'src/fig.py', 'commit': before, 'exists': True, 'text': 'print("one")\n',
        'binary': False, 'annexed': False, 'truncated': False,
    }
    missing = versions.read_source(root, before, 'src/other.py')
    assert missing['exists'] is False and missing['text'] is None


def test_a_script_of_a_project_below_the_repository_root_resolves_from_the_project(tmp_path):
    repository = init_repo(tmp_path / 'repository')
    root = repository / 'analysis'
    root.mkdir()
    commit = commit_files(root, {'fig.py': b'x = 1\n'}, 'Add the script')
    assert versions.read_source(root, commit, 'fig.py')['text'] == 'x = 1\n'


def test_binary_oversized_and_annexed_files_are_not_shown_as_text(tmp_path, monkeypatch):
    root = init_repo(tmp_path / 'project')
    commit = commit_files(root, {'blob.bin': b'\x00\x01', 'latin.txt': 'é'.encode('latin-1'), 'big.py': b'#' * 64}, 'Files')
    assert versions.read_source(root, commit, 'blob.bin')['binary'] is True
    assert versions.read_source(root, commit, 'latin.txt')['binary'] is True
    monkeypatch.setattr(versions, 'MAX_SOURCE_BYTES', 10)
    big = versions.read_source(root, commit, 'big.py')
    assert big['truncated'] is True and big['text'] is None
    monkeypatch.undo()
    fig = materialize(root, b'\x89PNG one')
    assert versions.read_source(root, fig, 'results/baseline/fig.png')['annexed'] is True
    assert versions.read_source(root, fig, 'results/baseline/.fig.manifest.json')['annexed'] is False


@pytest.mark.parametrize('file', ['', '/etc/passwd', '../outside.py', 'a/../b.py', 'a//b.py', './a.py', 'a\\b.py', 'a\x00b.py', 'x' * 1025])
def test_rejects_paths_that_leave_the_project_or_break_a_request(file):
    with pytest.raises(HTTPError) as error:
        versions.validate_source_path(file, allow_hidden=False)
    assert error.value.status_code == 400


def test_hidden_files_follow_the_contents_managers_rule():
    with pytest.raises(HTTPError) as error:
        versions.validate_source_path('.env', allow_hidden=False)
    assert error.value.status_code == 403
    with pytest.raises(HTTPError):
        versions.validate_source_path('config/.secret/key.py', allow_hidden=False)
    assert versions.validate_source_path('.env', allow_hidden=True) == '.env'
    assert versions.validate_source_path('src/fig.py', allow_hidden=False) == 'src/fig.py'


def test_lists_the_packages_locked_at_a_commit_and_now(tmp_path):
    root = init_repo(tmp_path / 'project')
    before = commit_files(root, {'uv.lock': LOCK_V1}, 'Lock')
    commit_files(root, {'uv.lock': LOCK_V1.replace(b'2.1.0', b'2.2.0')}, 'Upgrade numpy')
    answer = versions.locked_packages(root, before)
    assert answer['commit'] == before
    assert answer['packages'] == [
        {'name': 'astropy', 'version': '6.0.0'},
        {'name': 'my-project', 'version': None},
        {'name': 'numpy', 'version': '2.1.0'},
    ]
    assert {'name': 'numpy', 'version': '2.2.0'} in answer['current']


def test_a_missing_or_malformed_lock_lists_nothing(tmp_path):
    root = init_repo(tmp_path / 'project')
    commit = git(root, 'rev-parse', 'HEAD').strip()
    assert versions.locked_packages(root, commit) == {'commit': commit, 'packages': None, 'current': None}
    assert versions.parse_lock_packages(b'not = [toml') is None
    assert versions.parse_lock_packages(b'version = 1\n') is None
    assert versions.parse_lock_packages(b'\xff') is None


def test_revision_routes_reject_unknown_and_malformed_commits(tmp_path):
    root = init_repo(tmp_path / 'project')
    with pytest.raises(HTTPError) as error:
        versions.read_source(root, 'nope', 'fig.py')
    assert error.value.status_code == 400
    with pytest.raises(HTTPError) as error:
        versions.locked_packages(root, 'b' * 40)
    assert error.value.status_code == 404


async def test_source_and_packages_endpoints(jp_fetch, jp_serverapp):
    root = init_repo(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    commit = commit_files(root, {'fig.py': b'print(1)\n', 'uv.lock': LOCK_V1}, 'Script and lock')
    response = await jp_fetch(*SOURCE, params={'path': 'project/astra.yaml', 'commit': commit, 'file': 'fig.py'})
    assert json.loads(response.body)['text'] == 'print(1)\n'
    assert response.headers['Cache-Control'] == 'no-store'
    hidden = await jp_fetch(*SOURCE, params={'path': 'project/astra.yaml', 'commit': commit, 'file': '.gitattributes'}, raise_error=False)
    assert hidden.code == 403
    response = await jp_fetch(*PACKAGES, params={'path': 'project/astra.yaml', 'commit': commit})
    assert json.loads(response.body)['packages'][0] == {'name': 'astropy', 'version': '6.0.0'}
