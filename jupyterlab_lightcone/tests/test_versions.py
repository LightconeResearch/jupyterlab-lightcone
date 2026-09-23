"""Output versions come from real git and git-annex history, read and never written."""
import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import Mock

from lightcone.engine import dataset, templates
import pytest
from tornado.web import HTTPError

from jupyterlab_lightcone import versions
from jupyterlab_lightcone.projects import expose_engine_tools

ENDPOINT = ('jupyterlab_lightcone', 'api', 'versions')
CONTENT = (*ENDPOINT, 'content')
SOURCE = (*ENDPOINT, 'source')
PACKAGES = (*ENDPOINT, 'packages')
RESULTS = Path('results', 'baseline')
OUTPUTS = ['results/baseline/fig.png', 'results/baseline/.fig.manifest.json']


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return '/user/researcher/'


@pytest.fixture(autouse=True)
def engine_tools():
    """`git annex` must find the git-annex installed beside the engine, as it does in the server."""
    expose_engine_tools()


def registered(web_app, handler):
    return any(rule.target is handler for host in web_app.wildcard_router.rules for rule in getattr(host.target, 'rules', []))


@pytest.fixture
def jp_serverapp(jp_serverapp):
    """The versions routes, registered as `application.py` registers them; a no-op once it does."""
    if not registered(jp_serverapp.web_app, versions.OutputVersionsHandler):
        versions.setup_versions_handlers(jp_serverapp.web_app)
    return jp_serverapp


def git(root, *args):
    return subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, check=True).stdout


def manifest(output='fig', **changes):
    record = dict(schema_version=1, universe_id='baseline', output_id=output, finished_at='2026-09-15T10:00:00Z', git_sha='a' * 40, recipe=f'python {output}.py', env_version='sha256:env', lc_version='0.5', input_versions={'data': 'sha256:input'})
    record.update(changes)
    return record


def run_message(cmd, output='fig', exit_code=0):
    """A commit message shaped exactly as the engine's `run_record` writes it."""
    info = {'chain': [], 'cmd': cmd, 'dsid': 'dataset', 'exit': exit_code, 'inputs': ['data/in.txt'], 'outputs': OUTPUTS, 'pwd': '.'}
    body = json.dumps(info, indent=1, sort_keys=True)
    return f'[DATALAD RUNCMD] {output} [baseline]\n\n{versions.RUN_RECORD_START}\n{body}\n{versions.RUN_RECORD_END}'


def init_project(root):
    """A project repository as the engine converges one: git, an annex and its storage policy."""
    root.mkdir(parents=True, exist_ok=True)
    dataset.init_git(root)
    git(root, 'config', 'user.name', 'Researcher')
    git(root, 'config', 'user.email', 'researcher@example.org')
    dataset.init_annex(root)
    dataset.set_annex_filter_required(root)
    (root / '.gitattributes').write_text(templates.read('gitattributes.tmpl'))
    (root / 'astra.yaml').write_text('version: 0.0.14\n')
    dataset.save(root, ['.gitattributes', 'astra.yaml'], 'Initial project')
    return root


def init_plain_repo(root, name, content, *options):
    """A repository without an annex, holding one result file committed by hand; returns the commit."""
    root.mkdir(parents=True)
    git(root, 'init', '-q', *options)
    git(root, 'config', 'user.name', 'Researcher')
    git(root, 'config', 'user.email', 'researcher@example.org')
    (root / RESULTS).mkdir(parents=True)
    (root / RESULTS / name).write_bytes(content)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', f'Add {name} by hand')
    return git(root, 'rev-parse', 'HEAD').strip()


def commit_blob(root, path, content, message):
    """Commit bytes exactly as given, past git-annex's filter, as a hand edit of a pointer would land."""
    blob = subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=root, input=content, capture_output=True, check=True).stdout.decode().strip()
    git(root, 'update-index', '--cacheinfo', f'100644,{blob},{path}')
    git(root, 'commit', '-q', '-m', message)
    return git(root, 'rev-parse', 'HEAD').strip()


def materialize(root, content, message=None, record=None, output='fig', extension='png'):
    """Write an output and commit it the way one engine run does.

    The worker removes the previous output before rebuilding; overwriting it
    in place would rewrite the previous annex object through the thin hard link.
    """
    directory = root / RESULTS
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / f'{output}.{extension}'
    file.unlink(missing_ok=True)
    file.write_bytes(content)
    (directory / f'.{output}.manifest.json').write_text(json.dumps(manifest(output) if record is None else record))
    owned = [f':(glob)results/baseline/{output}.*', f':(glob)results/baseline/.{output}.manifest.json*']
    dataset.save(root, owned, message or run_message(f'python {output}.py'))
    return git(root, 'rev-parse', 'HEAD').strip()


@pytest.fixture
def project(tmp_path):
    """Two engine materializations of `fig`; returns the root and the commits, newest first."""
    root = init_project(tmp_path / 'project')
    first = materialize(root, b'\x89PNG one', run_message('python fig.py --first'))
    second = materialize(root, b'\x89PNG two', run_message('python fig.py --second'))
    return root, [second, first]


def test_lists_engine_versions_newest_first(project):
    root, (second, first) = project
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert listing['file'] == 'results/baseline/fig.png'
    assert [version['commit'] for version in listing['versions']] == [second, first]
    newest, oldest = listing['versions']
    assert newest['short'] == second[:7]
    assert newest['subject'] == '[DATALAD RUNCMD] fig [baseline]'
    assert datetime.fromisoformat(newest['time']).tzinfo is not None
    assert newest['key'].startswith('SHA256E-s8--') and newest['key'].endswith('.png')
    assert newest['size'] == 8
    assert newest['present'] is True
    assert newest['run'] == {'cmd': 'python fig.py --second', 'exit': 0, 'inputs': ['data/in.txt'], 'outputs': OUTPUTS}
    assert newest['manifest'] == manifest()
    assert oldest['run']['cmd'] == 'python fig.py --first'
    assert oldest['present'] is True
    assert oldest['key'] != newest['key']


def test_reads_the_bytes_at_each_commit_by_full_or_short_name(project):
    root, (second, first) = project
    assert versions.read_version(root, 'baseline', 'fig', first) == ('results/baseline/fig.png', b'\x89PNG one')
    assert versions.read_version(root, 'baseline', 'fig', second[:7]) == ('results/baseline/fig.png', b'\x89PNG two')


def test_dropped_content_is_absent_but_still_listed(project):
    root, (_, first) = project
    old_key = versions.list_versions(root, 'baseline', 'fig')['versions'][1]['key']
    git(root, 'annex', 'dropkey', '--force', old_key)
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [version['present'] for version in listing['versions']] == [True, False]
    assert listing['versions'][1]['key'] == old_key
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', first)
    assert raised.value.status_code == 404
    assert raised.value.reason == 'absent'


def test_a_hand_edit_between_runs_has_no_run_record(project):
    root, _ = project
    commit = materialize(root, b'\x89PNG edited', 'Touch up the figure by hand')
    newest = versions.list_versions(root, 'baseline', 'fig')['versions'][0]
    assert newest['commit'] == commit
    assert newest['subject'] == 'Touch up the figure by hand'
    assert newest['run'] is None
    assert newest['manifest'] == manifest()


def test_a_manifest_failing_the_provenance_checks_is_null(project):
    root, _ = project
    commit = materialize(root, b'\x89PNG three', record=manifest(output_id='other'))
    newest = versions.list_versions(root, 'baseline', 'fig')['versions'][0]
    assert newest['commit'] == commit
    assert newest['manifest'] is None
    assert newest['run']['cmd'] == 'python fig.py'


def test_a_project_without_an_annex_keeps_its_bytes_in_git(tmp_path):
    root = tmp_path / 'plain'
    commit = init_plain_repo(root, 'table.csv', b'a,b\n1,2\n')
    listing = versions.list_versions(root, 'baseline', 'table')
    assert listing['file'] == 'results/baseline/table.csv'
    [version] = listing['versions']
    assert version['commit'] == commit
    assert version['key'] is None
    assert version['size'] == 8
    assert version['present'] is True
    assert version['run'] is None
    assert version['manifest'] is None
    assert versions.read_version(root, 'baseline', 'table', version['commit'])[1] == b'a,b\n1,2\n'


def test_a_sha256_repository_serves_every_commit_it_lists(tmp_path):
    root = tmp_path / 'plain'
    commit = init_plain_repo(root, 'table.csv', b'a,b\n1,2\n', '--object-format=sha256')
    [version] = versions.list_versions(root, 'baseline', 'table')['versions']
    assert (version['commit'], len(commit)) == (commit, 64)
    assert versions.read_version(root, 'baseline', 'table', commit)[1] == b'a,b\n1,2\n'


def test_a_version_where_the_file_was_deleted_has_no_bytes(project):
    root, (second, _) = project
    (root / RESULTS / 'fig.png').unlink()
    dataset.save(root, [':(glob)results/baseline/fig.*'], 'Remove the figure')
    # Neither the working tree nor the last commit has a file to name the format by.
    with pytest.raises(HTTPError) as raised:
        versions.list_versions(root, 'baseline', 'fig')
    assert raised.value.status_code == 404
    (root / RESULTS / 'fig.png').write_bytes(b'\x89PNG again')
    dataset.save(root, [':(glob)results/baseline/fig.*'], 'Restore the figure')
    listing = versions.list_versions(root, 'baseline', 'fig')
    removed = next(version for version in listing['versions'] if version['subject'] == 'Remove the figure')
    assert removed == {**removed, 'key': None, 'size': None, 'present': False, 'run': None, 'manifest': manifest()}
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', removed['commit'])
    assert raised.value.status_code == 404
    assert raised.value.reason == 'missing'
    assert versions.read_version(root, 'baseline', 'fig', second)[1] == b'\x89PNG two'


def test_the_history_stays_readable_while_a_run_rebuilds_the_output(project):
    """The engine deletes the output and its manifest before rebuilding; the last commit still names it."""
    root, (second, first) = project
    (root / RESULTS / 'fig.png').unlink()
    (root / RESULTS / '.fig.manifest.json').unlink()
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert listing['file'] == 'results/baseline/fig.png'
    assert [(version['commit'], version['present']) for version in listing['versions']] == [(second, True), (first, True)]
    assert versions.read_version(root, 'baseline', 'fig', first) == ('results/baseline/fig.png', b'\x89PNG one')


def test_a_locked_version_names_its_annex_key(project):
    """A researcher may lock an annexed file: the commit then holds a symlink into the object store."""
    root, (second, _) = project
    git(root, 'annex', 'lock', '--force', 'results/baseline/fig.png')
    git(root, 'commit', '-q', '-m', 'Lock the figure')
    locked, unlocked, _ = versions.list_versions(root, 'baseline', 'fig')['versions']
    assert locked['subject'] == 'Lock the figure'
    assert unlocked['commit'] == second
    assert (locked['key'], locked['size'], locked['present']) == (unlocked['key'], 8, True)
    assert versions.read_version(root, 'baseline', 'fig', locked['commit'])[1] == b'\x89PNG two'
    git(root, 'annex', 'dropkey', '--force', locked['key'])
    assert versions.list_versions(root, 'baseline', 'fig')['versions'][0]['present'] is False
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', locked['commit'])
    assert raised.value.reason == 'absent'


def test_commit_messages_cannot_forge_or_hide_versions(project):
    root, (second, first) = project
    forged = 'Touch up\x1eHEAD:.env\nzzz\x1f2026-01-01T00:00:00+00:00\x1fFORGED\x1fforged body\x1e'
    third = materialize(root, b'\x89PNG three', forged)
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [version['commit'] for version in listing['versions']] == [third, second, first]
    newest = listing['versions'][0]
    assert newest['subject'] == git(root, 'log', '-1', '--format=%s', third).removesuffix('\n')
    assert newest['key'].startswith('SHA256E-s10--')
    assert (newest['size'], newest['present'], newest['run']) == (10, True, None)
    assert all(version['present'] for version in listing['versions'])


@pytest.mark.skipif(shutil.which('ssh-keygen') is None, reason='signing a commit needs ssh-keygen')
def test_signed_commits_list_under_a_users_show_signature_setting(project, tmp_path):
    """`log.showSignature` prints a verdict before every signed commit, into the output the listing parses."""
    root, (second, first) = project
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(tmp_path / 'signing')], check=True, capture_output=True)
    for key, value in [('gpg.format', 'ssh'), ('user.signingkey', str(tmp_path / 'signing')), ('commit.gpgsign', 'true'), ('log.showSignature', 'true')]:
        git(root, 'config', key, value)
    third = materialize(root, b'\x89PNG three')
    assert git(root, 'cat-file', 'commit', third).count('-----BEGIN SSH SIGNATURE-----') == 1
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [(version['commit'], version['size'], version['present']) for version in listing['versions']] == [(third, 10, True), (second, 8, True), (first, 8, True)]


def test_a_malformed_pointer_is_content_and_spares_the_other_keys(project):
    """git-annex abandons a batch at a key it cannot parse, so such a key never reaches it."""
    root, (second, first) = project
    pointer = b'/annex/objects/MD5-nope\n'
    malformed = commit_blob(root, 'results/baseline/fig.png', pointer, 'Hand-edit the pointer')
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [(version['commit'], version['key'] is None, version['size'], version['present']) for version in listing['versions']] == [
        (malformed, True, len(pointer), True),
        (second, False, 8, True),
        (first, False, 8, True),
    ]
    assert versions.read_version(root, 'baseline', 'fig', malformed)[1] == pointer


def test_listing_a_clone_leaves_its_annex_uninitialized(project, tmp_path):
    """Any git-annex command would initialize a fresh clone; a read must not write to it."""
    root, (second, first) = project
    clone = tmp_path / 'clone'
    git(tmp_path, 'clone', '-q', str(root), str(clone))
    listing = versions.list_versions(clone, 'baseline', 'fig')
    assert [(version['commit'], version['size'], version['present']) for version in listing['versions']] == [(second, 8, False), (first, 8, False)]
    with pytest.raises(HTTPError) as raised:
        versions.read_version(clone, 'baseline', 'fig', second)
    assert raised.value.reason == 'absent'
    assert subprocess.run(['git', 'config', '--get', 'annex.uuid'], cwd=clone, capture_output=True).returncode == 1
    assert not (clone / '.git' / 'annex').exists()
    assert git(clone, 'branch', '--list', 'git-annex') == ''


def test_pointer_files_are_absent_without_git_annex(project, monkeypatch):
    root, (second, _) = project
    run_git = versions.run_git

    def without_annex(directory, *args, stdin=None):
        if 'annex' in args:
            return subprocess.CompletedProcess(['git', *args], 1, b'', b"git: 'annex' is not a git command.")
        return run_git(directory, *args, stdin=stdin)

    monkeypatch.setattr(versions, 'run_git', without_annex)
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert [(version['key'][:12], version['size'], version['present']) for version in listing['versions']] == [('SHA256E-s8--', 8, False)] * 2
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', second)
    assert (raised.value.status_code, raised.value.reason) == (404, 'absent')


def test_names_with_control_characters_are_never_outputs(project):
    """A line break in a name would split a git batch request and shift every answer after it."""
    root, (second, first) = project
    (root / RESULTS / 'fig.a\nHEAD:astra.yaml').write_bytes(b'decoy')
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert listing['file'] == 'results/baseline/fig.png'
    assert [(version['commit'], version['size'], version['present']) for version in listing['versions']] == [(second, 8, True), (first, 8, True)]
    assert versions.read_version(root, 'baseline', 'fig', first)[1] == b'\x89PNG one'
    for universe, output in [('base\nline', 'fig'), ('baseline', 'fig\n')]:
        with pytest.raises(HTTPError) as raised:
            versions.list_versions(root, universe, output)
        assert raised.value.status_code == 400
    with pytest.raises(ValueError):
        versions.batch_input(['HEAD:./fig.png', 'HEAD\n:./astra.yaml'])


def test_names_that_are_not_utf8_are_never_outputs(project):
    """git's batch input is written as UTF-8, which such a name cannot be, whether it is on disk or committed."""
    root, (second, first) = project
    decoy = f'{RESULTS.as_posix()}/fig.a{os.fsdecode(bytes([0xff]))}'
    (root / decoy).write_bytes(b'decoy')
    assert versions.list_versions(root, 'baseline', 'fig')['file'] == 'results/baseline/fig.png'
    # Committed past the annex, which refuses the name, and without decoding git's output, which echoes it.
    blob = subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=root, input=b'decoy', capture_output=True, check=True).stdout.decode().strip()
    subprocess.run(['git', 'update-index', '--add', '--cacheinfo', f'100644,{blob},{decoy}'], cwd=root, capture_output=True, check=True)
    subprocess.run(['git', 'commit', '-q', '-m', 'Commit a decoy'], cwd=root, capture_output=True, check=True)
    assert decoy in os.fsdecode(subprocess.run(['git', 'ls-tree', '-z', '--name-only', 'HEAD', '--', f'{RESULTS.as_posix()}/'], cwd=root, capture_output=True, check=True).stdout)
    listing = versions.list_versions(root, 'baseline', 'fig')
    assert (listing['file'], [version['commit'] for version in listing['versions']]) == ('results/baseline/fig.png', [second, first])
    # With the working tree emptied by a rebuild, the last commit's names are filtered alike.
    (root / decoy).unlink()
    (root / RESULTS / 'fig.png').unlink()
    assert versions.list_versions(root, 'baseline', 'fig')['file'] == 'results/baseline/fig.png'
    assert versions.read_version(root, 'baseline', 'fig', first)[1] == b'\x89PNG one'
    with pytest.raises(ValueError):
        versions.batch_input([f'HEAD:./{decoy}'])


def test_prefers_the_file_the_manifest_names_when_several_remain(project):
    root, _ = project
    (root / RESULTS / 'fig.svg').write_text('<svg/>')
    assert versions.output_file(root, 'baseline', 'fig')[0] == 'results/baseline/fig.png'
    (root / RESULTS / '.fig.manifest.json').write_text(json.dumps(manifest(output_path='results/baseline/fig.svg')))
    assert versions.output_file(root, 'baseline', 'fig') == ('results/baseline/fig.svg', 'results/baseline/.fig.manifest.json')


def test_an_output_without_a_file_is_not_found(project):
    root, _ = project
    with pytest.raises(HTTPError) as raised:
        versions.list_versions(root, 'baseline', 'never')
    assert raised.value.status_code == 404
    with pytest.raises(HTTPError) as raised:
        versions.list_versions(root, 'other', 'fig')
    assert raised.value.status_code == 404


def test_a_folder_without_git_has_no_history(tmp_path):
    (tmp_path / RESULTS).mkdir(parents=True)
    (tmp_path / RESULTS / 'fig.png').write_bytes(b'\x89PNG')
    assert versions.list_versions(tmp_path, 'baseline', 'fig') == {'file': 'results/baseline/fig.png', 'versions': []}


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


def test_an_unknown_commit_is_not_found(project):
    root, _ = project
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', '0' * 40)
    assert raised.value.status_code == 404
    assert raised.value.reason == 'commit'


def test_refuses_oversized_content(project, tmp_path, monkeypatch):
    root, (second, _) = project
    monkeypatch.setattr(versions, 'MAX_CONTENT_BYTES', 4)
    with pytest.raises(HTTPError) as raised:
        versions.read_version(root, 'baseline', 'fig', second)
    assert raised.value.status_code == 413
    assert raised.value.log_message == 'This version is larger than the 4 bytes the viewer serves'
    plain = tmp_path / 'plain'
    init_plain_repo(plain, 'big.txt', b'x' * (versions.POINTER_MAX_BYTES + 1))
    [version] = versions.list_versions(plain, 'baseline', 'big')['versions']
    assert version['size'] == versions.POINTER_MAX_BYTES + 1 and version['key'] is None
    with pytest.raises(HTTPError) as raised:
        versions.read_version(plain, 'baseline', 'big', version['commit'])
    assert raised.value.status_code == 413


def test_the_refusal_names_the_default_limit():
    assert versions.too_large().log_message == 'This version is larger than the 50 MiB the viewer serves'


def test_parses_the_engines_run_record():
    record = versions.parse_run_record(run_message('python fig.py', exit_code=3))
    assert record == {'cmd': 'python fig.py', 'exit': 3, 'inputs': ['data/in.txt'], 'outputs': OUTPUTS}


@pytest.mark.parametrize('message', [
    'No record here',
    f'{versions.RUN_RECORD_START}\nnot json\n{versions.RUN_RECORD_END}',
    f'{versions.RUN_RECORD_START}\n[]\n{versions.RUN_RECORD_END}',
    f'{versions.RUN_RECORD_END}\n{{}}\n{versions.RUN_RECORD_START}',
    f'{versions.RUN_RECORD_START}\n{{"cmd": "x", "exit": "0", "inputs": [], "outputs": []}}\n{versions.RUN_RECORD_END}',
    f'{versions.RUN_RECORD_START}\n{{"cmd": "x", "exit": true, "inputs": [], "outputs": []}}\n{versions.RUN_RECORD_END}',
    f'{versions.RUN_RECORD_START}\n{{"cmd": "x", "exit": 0, "inputs": [1], "outputs": []}}\n{versions.RUN_RECORD_END}',
    f'{versions.RUN_RECORD_START}\n{{"cmd": "x", "exit": 0, "inputs": []}}\n{versions.RUN_RECORD_END}',
])
def test_malformed_run_records_are_null(message):
    assert versions.parse_run_record(message) is None


POINTERS = [
    (b'/annex/objects/SHA256E-s8--abc.png\n', 'SHA256E-s8--abc.png'),
    (b'/annex/objects/SHA256E-s8--abc.png', 'SHA256E-s8--abc.png'),
    (b'/annex/objects/MD5-s12--abc\r\n', 'MD5-s12--abc'),
    (b'/annex/objects/MD5-s12--abc\n/annex/label\n', 'MD5-s12--abc'),
    (b'/annex/objects/MD5-s12--abc\nextra\n', None),
    (b'/annex/objects/MD5-s12--abc\n/annex/label', None),
    (b'/annex/objects/MD5-s12--abc\n\n', None),
    (b'\x89PNG real content', None),
    (b'/annex/objects/', None),
    (b'/annex/objects/bad key\n', None),
    (b'/annex/objects/' + b'x' * versions.POINTER_MAX_BYTES, None),
    (b'../../.git/annex/objects/qf/06/SHA256E-s8--abc.png/SHA256E-s8--abc.png', 'SHA256E-s8--abc.png'),
    (b'../.git/annex/objects/abc/def/MD5-s3--x/MD5-s3--x', 'MD5-s3--x'),
    (b'see:/annex/objects/elsewhere/SHA256E-s8--abc.png', 'SHA256E-s8--abc.png'),
    (b'/ANNEX/objects/SHA256E-s8--abc.png\n', None),
    (b'/annex/objects/MD5-nope\n', None),
    (b'/annex/objects/--abc\n', None),
    (b'/annex/objects/SHA256E-m1-s8--abc\n', None),
    (b'/annex/objects/SHA256E-s8-m1-S2-C3--abc\n', 'SHA256E-s8-m1-S2-C3--abc'),
]
"""Committed blobs and the key each names, as git-annex itself reads them."""


@pytest.mark.parametrize('blob, key', POINTERS)
def test_recognizes_annex_pointers(blob, key):
    assert versions.pointer_key(blob) == key


def test_reads_pointers_as_git_annex_does(project):
    """The bytes served for a version are the ones git-annex checks out, so its parser is the reference."""
    root, _ = project
    objects = [subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=root, input=blob, capture_output=True, check=True).stdout.decode().strip() for blob, _ in POINTERS]
    looked_up = subprocess.run(['git', 'annex', 'lookupkey', '--ref', '--batch'], cwd=root, input=''.join(f'{name}\n' for name in objects), capture_output=True, text=True, check=True)
    assert [line or None for line in looked_up.stdout.split('\n')[:-1]] == [key for _, key in POINTERS]


@pytest.mark.parametrize('key, size', [('SHA256E-s208410--01ec.png', 208410), ('MD5-s12--abc', 12), ('URL--http&c%%example.com%file', None), ('WORM-s5-m1700000000--name', 5)])
def test_reads_the_size_a_key_records(key, size):
    assert versions.key_size(key) == size


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


async def test_versions_endpoint(jp_fetch, jp_serverapp):
    root = init_project(Path(jp_serverapp.contents_manager.root_dir) / 'project')
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
    root = init_project(Path(jp_serverapp.contents_manager.root_dir) / 'project')
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
    root = init_project(Path(jp_serverapp.contents_manager.root_dir) / 'project')
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
    root = init_project(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    first = materialize(root, b'\x89PNG one')
    materialize(root, b'\x89PNG two')
    old_key = versions.list_versions(root, 'baseline', 'fig')['versions'][1]['key']
    git(root, 'annex', 'dropkey', '--force', old_key)
    params = {'path': 'project/astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': first}
    response = await jp_fetch(*CONTENT, params=params, raise_error=False)
    assert response.code == 404
    assert json.loads(response.body)['reason'] == 'absent'
    assert response.headers['Cache-Control'] == 'no-store'
    response = await jp_fetch(*CONTENT, params={**params, 'commit': 'nope'}, raise_error=False)
    assert response.code == 400


@pytest.mark.parametrize('endpoint', [ENDPOINT, CONTENT, SOURCE, PACKAGES])
async def test_requires_authentication(jp_fetch, endpoint):
    params = {'path': 'astra.yaml', 'universe': 'baseline', 'output': 'fig', 'commit': 'a' * 7, 'file': 'fig.py'}
    response = await jp_fetch(*endpoint, params=params, follow_redirects=False, headers={'Authorization': ''}, raise_error=False)
    assert response.code in (302, 403)


@pytest.mark.parametrize('endpoint', [ENDPOINT, CONTENT, SOURCE, PACKAGES])
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
    root = init_project(tmp_path / 'project')
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
    repository = tmp_path / 'repository'
    root = init_project(repository / 'analysis')
    commit = commit_files(root, {'fig.py': b'x = 1\n'}, 'Add the script')
    assert versions.read_source(root, commit, 'fig.py')['text'] == 'x = 1\n'


def test_binary_oversized_and_annexed_files_are_not_shown_as_text(tmp_path, monkeypatch):
    root = init_project(tmp_path / 'project')
    commit = commit_files(root, {'blob.bin': b'\x00\x01', 'latin.txt': 'é'.encode('latin-1'), 'big.py': b'#' * 64}, 'Files')
    assert versions.read_source(root, commit, 'blob.bin')['binary'] is True
    assert versions.read_source(root, commit, 'latin.txt')['binary'] is True
    monkeypatch.setattr(versions, 'MAX_SOURCE_BYTES', 10)
    big = versions.read_source(root, commit, 'big.py')
    assert big['truncated'] is True and big['text'] is None
    monkeypatch.undo()
    fig = materialize(root, b'\x89PNG one')
    assert versions.read_source(root, fig, 'results/baseline/fig.png')['annexed'] is True


@pytest.mark.parametrize('file', ['', '/etc/passwd', '../outside.py', 'a/../b.py', 'a//b.py', './a.py', 'a\\b.py', 'a\nb.py', 'x' * 1025])
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
    root = init_project(tmp_path / 'project')
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
    root = init_project(tmp_path / 'project')
    commit = git(root, 'rev-parse', 'HEAD').strip()
    assert versions.locked_packages(root, commit) == {'commit': commit, 'packages': None, 'current': None}
    assert versions.parse_lock_packages(b'not = [toml') is None
    assert versions.parse_lock_packages(b'version = 1\n') is None
    assert versions.parse_lock_packages(b'\xff') is None


def test_revision_routes_reject_unknown_and_malformed_commits(tmp_path):
    root = init_project(tmp_path / 'project')
    with pytest.raises(HTTPError) as error:
        versions.read_source(root, 'nope', 'fig.py')
    assert error.value.status_code == 400
    with pytest.raises(HTTPError) as error:
        versions.locked_packages(root, 'b' * 40)
    assert error.value.status_code == 404


async def test_source_and_packages_endpoints(jp_fetch, jp_serverapp):
    root = init_project(Path(jp_serverapp.contents_manager.root_dir) / 'project')
    commit = commit_files(root, {'fig.py': b'print(1)\n', 'uv.lock': LOCK_V1}, 'Script and lock')
    response = await jp_fetch(*SOURCE, params={'path': 'project/astra.yaml', 'commit': commit, 'file': 'fig.py'})
    assert json.loads(response.body)['text'] == 'print(1)\n'
    assert response.headers['Cache-Control'] == 'no-store'
    hidden = await jp_fetch(*SOURCE, params={'path': 'project/astra.yaml', 'commit': commit, 'file': '.gitattributes'}, raise_error=False)
    assert hidden.code == 403
    response = await jp_fetch(*PACKAGES, params={'path': 'project/astra.yaml', 'commit': commit})
    assert json.loads(response.body)['packages'][0] == {'name': 'astropy', 'version': '6.0.0'}
