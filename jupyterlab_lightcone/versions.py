"""Committed versions of a materialized output: git history and git-annex bytes.

The engine commits every materialization as ``[DATALAD RUNCMD] <output>
[<universe>]`` with the run record in the message, keeps the bytes in
git-annex behind a pointer (an unlocked file, or a symlink once a researcher
locks it), and writes a manifest sidecar beside the output. These routes read
that history back for one output: the commits that touched its file, what
each of them recorded, and the bytes at any of them. Nothing here writes to
the repository.
"""

import asyncio
import json
import os
import re
import subprocess
import urllib.parse
from pathlib import Path, PurePosixPath

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler
from .provenance import MAX_RECORD_BYTES, ensure_results_visible, record_path, validate_record

MAX_VERSIONS = 200
"""How many commits one listing reaches back."""

MAX_CONTENT_BYTES = 50 * 1024 * 1024
"""The largest version the content route serves."""

GIT_TIMEOUT = 60.0
"""Seconds one git or git-annex command may take."""

POINTER_PREFIX = b"/annex/objects/"
POINTER_LABEL = b"/annex/"
POINTER_MAX_BYTES = 32 * 1024
"""git-annex's own pointer rule: at most 32 KiB, a first line holding the prefix, and any later line a label."""

RUN_RECORD_START = "=== Do not change lines below ==="
RUN_RECORD_END = "^^^ Do not change lines above ^^^"
"""The markers DataLad, and the engine, put around the run record in a commit."""

CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "svg": "image/svg+xml",
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "txt": "text/plain; charset=utf-8",
    "pdf": "application/pdf",
    "npz": "application/octet-stream",
}
DEFAULT_CONTENT_TYPE = "application/octet-stream"

_COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
_OBJECT_NAME = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_KEY = re.compile(r"[^-]+(?:-s(\d+))?(?:-m\d+)?(?:-S\d+)?(?:-C\d+)?--.*")
"""git-annex's key grammar: a backend, then the optional size, mtime, chunk
size and chunk number fields in that order, then ``--`` and the name."""
_UNSAFE_KEY = re.compile(r"[\s/\\\x00-\x1f\x7f]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


# =============================================================================
# Running git
# =============================================================================


def run_git(project: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    """Run one git command in the project, never through a shell, keeping stdout raw.

    Blob contents are binary, so stdout stays undecoded and callers decode the
    text they expect. A missing git and a hung command are service errors; a
    nonzero exit is the caller's to interpret, because "cannot say" is often
    the right answer for a read-only route.
    """
    try:
        return subprocess.run(
            ["git", *args],
            cwd=project,
            capture_output=True,
            input=None if stdin is None else stdin.encode(),
            timeout=GIT_TIMEOUT,
            check=False,
        )
    except FileNotFoundError as error:
        raise web.HTTPError(503, "git is required to read output versions") from error
    except subprocess.TimeoutExpired as error:
        raise web.HTTPError(503, "git did not answer in time") from error


def batchable(text: str) -> bool:
    """Whether text can travel as one request line: UTF-8 without a control character.

    A control character would split a request in two and shift every answer
    after it; a file name that is not UTF-8 (read back with surrogate escapes)
    cannot be written to git's input at all.
    """
    if _CONTROL.search(text):
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def batch_input(items: list[str]) -> str:
    """One request per line for git's ``--batch`` protocols, which answer line by line.

    Callers send only validated commits, paths and keys, so meeting one that
    is not ``batchable`` here is a bug to stop on, never a request to send.
    """
    if not all(batchable(item) for item in items):
        raise ValueError("A git batch request is not one line of UTF-8")
    return "".join(f"{item}\n" for item in items)


# =============================================================================
# The output file
# =============================================================================


def output_file(project: Path, universe: str, output: str) -> tuple[str, str]:
    """Locate the materialized file and its sidecar, as project-relative POSIX paths.

    The engine derives the file name from the declared format, which this route
    does not know, so the file is found beside its manifest as
    ``results/<universe>/<output>.*``. The hidden manifest cannot match: an
    output id contains no dot, so no match starts with one. When a re-declared
    format left several files, the manifest's ``output_path`` decides, else
    the first name alphabetically. Symlinks count, since a locked annex file
    without its content is a dangling one.

    The working tree answers first. A run deletes the output before rebuilding
    it, so while one is under way the last commit names the file instead and
    the history stays readable. A name that is not ``batchable`` (a control
    character, or bytes that are not UTF-8) is never an engine output and
    would break git's line-based batch protocols, so such names are skipped
    and such identities refused.
    """
    manifest = record_path(project, universe, output)
    if not (batchable(universe) and batchable(output)):
        raise web.HTTPError(400, "Invalid output identity")
    prefix = f"{output}."

    def matching(names: list[str]) -> list[str]:
        return sorted(name for name in names if name.startswith(prefix) and batchable(name))

    names = matching(working_tree_names(manifest.parent)) or matching(committed_names(project, universe))
    if not names:
        raise web.HTTPError(404, "This output has no materialized file")
    chosen = names[0]
    if len(names) > 1:
        preferred = manifest_output_name(manifest)
        if preferred in names:
            chosen = preferred
    directory = PurePosixPath("results", universe)
    return str(directory / chosen), str(directory / manifest.name)


def working_tree_names(directory: Path) -> list[str]:
    """The names of the files and symlinks in a results directory; none when it is missing."""
    try:
        with os.scandir(directory) as entries:
            return [entry.name for entry in entries if entry.is_file(follow_symlinks=False) or entry.is_symlink()]
    except FileNotFoundError:
        return []
    except OSError as error:
        raise web.HTTPError(503, "The results directory could not be read") from error


def committed_names(project: Path, universe: str) -> list[str]:
    """The names of the files and symlinks the last commit holds in a results directory.

    Nothing for a folder that is not a repository or has no commit yet. Files
    and symlinks are both blobs in a tree; directories and submodules are not.
    Names are decoded as ``os.scandir`` decodes them, so a name that is not
    UTF-8 keeps its escapes and fails ``batchable`` rather than turning into
    the name of a file that does not exist.
    """
    directory = f"{PurePosixPath('results', universe)}/"
    listed = run_git(project, "--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", directory)
    if listed.returncode != 0:
        return []
    names = []
    # Each entry reads "<mode> <type> <object>\t<path>".
    for entry in listed.stdout.decode("utf-8", "surrogateescape").split("\x00"):
        details, _, path = entry.partition("\t")
        if details.split(" ")[1:2] == ["blob"]:
            names.append(path.rpartition("/")[2])
    return names


def manifest_output_name(manifest: Path) -> str | None:
    """The file name the manifest on disk records as ``output_path``, if any."""
    try:
        with manifest.open("rb") as stream:
            data = json.loads(stream.read(MAX_RECORD_BYTES))
    except (OSError, ValueError, RecursionError):
        return None
    path = data.get("output_path") if isinstance(data, dict) else None
    return PurePosixPath(path).name if isinstance(path, str) and path else None


# =============================================================================
# History
# =============================================================================


def parse_run_record(message: str) -> dict | None:
    """The DataLad run record in a commit message; None without one or with a malformed one."""
    start = message.find(RUN_RECORD_START)
    if start < 0:
        return None
    start += len(RUN_RECORD_START)
    end = message.find(RUN_RECORD_END, start)
    if end < 0:
        return None
    try:
        info = json.loads(message[start:end])
    except ValueError:
        return None
    if not isinstance(info, dict):
        return None
    cmd, exit_code, inputs, outputs = (info.get(key) for key in ("cmd", "exit", "inputs", "outputs"))
    if (
        not isinstance(cmd, str)
        or not isinstance(exit_code, int)
        or isinstance(exit_code, bool)
        or not _strings(inputs)
        or not _strings(outputs)
    ):
        return None
    return {"cmd": cmd, "exit": exit_code, "inputs": inputs, "outputs": outputs}


def _strings(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def read_history(project: Path, file: str) -> list[dict]:
    """The commits that touched the file, newest first, each with its parsed run record.

    A folder that is not a repository, or one without a commit yet, has no
    history rather than an error: the output may simply never have been
    committed. Every field ends with a NUL, the one byte git never lets into a
    commit message, so no message can forge, merge or hide a row; the path is
    matched literally, never as a pattern. Signature checks are turned off,
    since a user's ``log.showSignature`` would print their verdict into the
    same output ahead of each signed commit.
    """
    if run_git(project, "rev-parse", "--verify", "--quiet", "HEAD").returncode != 0:
        return []
    listed = run_git(
        project,
        "--literal-pathspecs",
        "log",
        "-z",
        "--no-show-signature",
        f"--max-count={MAX_VERSIONS}",
        "--follow",
        "--format=%H%x00%cI%x00%s%x00%B",
        "--",
        file,
    )
    if listed.returncode != 0:
        raise web.HTTPError(503, "git could not list the output's history")
    # Four fields per commit, each ending with a NUL (``-z`` ends the record
    # with the fourth), so the text after the last NUL is empty.
    fields = listed.stdout.decode("utf-8", "replace").split("\x00")[:-1]
    if len(fields) % 4 or not all(_OBJECT_NAME.fullmatch(commit) for commit in fields[::4]):
        raise web.HTTPError(503, "git returned a history this route cannot read")
    history = []
    for start in range(0, len(fields), 4):
        commit, time, subject, body = fields[start : start + 4]
        history.append(
            {
                "commit": commit,
                "short": commit[:7],
                "time": time,
                "subject": subject,
                "run": parse_run_record(body),
            }
        )
    return history


# =============================================================================
# Blobs, pointers and annex content
# =============================================================================


def blob_sizes(project: Path, names: list[str]) -> dict[str, int | None]:
    """Sizes of git objects by name, in one process; None for an object that does not exist."""
    sizes: dict[str, int | None] = dict.fromkeys(names)
    if not names:
        return sizes
    checked = run_git(project, "cat-file", "--batch-check", stdin=batch_input(names))
    if checked.returncode != 0:
        raise web.HTTPError(503, "git could not inspect the output's versions")
    for name, line in zip(names, checked.stdout.decode("utf-8", "replace").splitlines()):
        fields = line.split()
        if len(fields) == 3 and fields[1] == "blob" and fields[2].isdigit():
            sizes[name] = int(fields[2])
    return sizes


def read_blobs(project: Path, names: list[str]) -> dict[str, bytes]:
    """Contents of git objects by name, in one process; objects that do not exist are left out."""
    if not names:
        return {}
    read = run_git(project, "cat-file", "--batch", stdin=batch_input(names))
    if read.returncode != 0:
        raise web.HTTPError(503, "git could not read the output's versions")
    blobs: dict[str, bytes] = {}
    data = read.stdout
    position = 0
    for name in names:
        newline = data.find(b"\n", position)
        if newline < 0:
            break
        header = data[position:newline].decode("utf-8", "replace").split()
        position = newline + 1
        # A missing object is a bare "<name> missing" line: nothing follows it.
        if len(header) != 3 or not header[2].isdigit():
            continue
        size = int(header[2])
        blobs[name] = data[position : position + size]
        # git terminates every object with a newline.
        position += size + 1
    return blobs


def pointer_key(blob: bytes) -> str | None:
    """The annex key a committed file refers to, or None when it holds real content.

    Both shapes a researcher can switch between with ``git annex lock`` and
    ``unlock`` are committed as a short blob: an unlocked file as the pointer
    ``/annex/objects/<key>``, a locked one as its symlink target
    ``…/annex/objects/<hash dirs>/<key>/<key>``. git-annex reads either the
    same way, and so does this: a blob of at most 32 KiB whose first line,
    less one trailing carriage return, holds ``/annex/objects/`` names the
    key in its last path segment. Every later line must be a label holding
    ``/annex/`` and ending in a newline; anything else appended makes the
    blob content. The key must parse as a git-annex key, since git-annex
    treats anything else as content and abandons a batch at the first key it
    cannot parse. A key holding whitespace, a backslash or a control
    character, which the engine's keys never do, is refused and stays content.
    """
    if len(blob) > POINTER_MAX_BYTES:
        return None
    first, _, rest = blob.partition(b"\n")
    first = first.removesuffix(b"\r")
    labels = rest.split(b"\n")
    if POINTER_PREFIX not in first or labels[-1] or not all(POINTER_LABEL in label for label in labels[:-1]):
        return None
    key = first.rpartition(b"/")[2].decode("utf-8", "replace")
    if _UNSAFE_KEY.search(key) or not _KEY.fullmatch(key):
        return None
    return key


def key_size(key: str) -> int | None:
    """The byte size a key records in its ``-s<size>`` field, when its backend has one."""
    match = _KEY.fullmatch(key)
    return int(match.group(1)) if match and match.group(1) else None


def annex_initialized(project: Path) -> bool:
    """Whether git-annex has initialized this repository, as the engine asks it.

    ``annex.uuid`` is the mark ``git annex init`` leaves. In a clone that has
    not been initialized, any git-annex command would initialize it: a UUID,
    ``.git/annex`` and commits on the ``git-annex`` branch.
    """
    return run_git(project, "config", "--get", "annex.uuid").returncode == 0


def content_locations(project: Path, keys: list[str]) -> dict[str, Path | None]:
    """Where git-annex holds each key's bytes; None when the content is not here.

    One process for every key: ``contentlocation --batch`` answers a line per
    key and a blank one for content it does not hold. A clone git-annex has not
    initialized holds no content, and asking would initialize it, so it is not
    asked; nor may git-annex upgrade the repository during a read. Only keys
    ``pointer_key`` accepted reach the batch, so none stops it early; if it
    stops anyway (git-annex missing, a repository it refuses), the keys it did
    not answer count as absent, which is all a viewer can say about them.
    """
    locations: dict[str, Path | None] = dict.fromkeys(keys)
    if not keys or not annex_initialized(project):
        return locations
    located = run_git(
        project,
        "-c",
        "annex.autoupgraderepository=false",
        "annex",
        "contentlocation",
        "--batch",
        stdin=batch_input(keys),
    )
    # Only complete lines are answers.
    for key, line in zip(keys, located.stdout.decode("utf-8", "replace").split("\n")[:-1]):
        if line.strip():
            locations[key] = project / line.strip()
    return locations


def validate_manifest(blob: bytes, universe: str, output: str) -> dict | None:
    """The manifest as the provenance route would serve it; None when it fails those checks."""
    try:
        return validate_record(blob, universe, output)
    except ValueError:
        return None


def too_large() -> web.HTTPError:
    """The refusal of a version beyond what the content route serves, naming the limit."""
    mebibyte = 1024 * 1024
    limit = f"{MAX_CONTENT_BYTES // mebibyte} MiB" if MAX_CONTENT_BYTES % mebibyte == 0 else f"{MAX_CONTENT_BYTES} bytes"
    return web.HTTPError(413, f"This version is larger than the {limit} the viewer serves")


# =============================================================================
# The two answers: the listing and the bytes
# =============================================================================


def list_versions(project: Path, universe: str, output: str) -> dict:
    """Every committed version of an output, newest first, with what each commit recorded."""
    file, manifest = output_file(project, universe, output)
    history = read_history(project, file)
    file_names = [f"{entry['commit']}:./{file}" for entry in history]
    manifest_names = [f"{entry['commit']}:./{manifest}" for entry in history]
    sizes = blob_sizes(project, [*file_names, *manifest_names])
    # Only pointers and manifests are read whole: real content can be large,
    # and for the listing only its size matters.
    wanted = [name for name in file_names if sizes[name] is not None and sizes[name] <= POINTER_MAX_BYTES]
    wanted += [name for name in manifest_names if sizes[name] is not None and sizes[name] <= MAX_RECORD_BYTES]
    blobs = read_blobs(project, wanted)
    keys = {name: pointer_key(blobs[name]) for name in file_names if name in blobs}
    locations = content_locations(project, sorted({key for key in keys.values() if key}))
    versions = []
    for entry, file_name, manifest_name in zip(history, file_names, manifest_names):
        key = keys.get(file_name)
        if key:
            size, present = key_size(key), locations.get(key) is not None
        else:
            size, present = sizes[file_name], sizes[file_name] is not None
        manifest_blob = blobs.get(manifest_name)
        versions.append(
            {
                **entry,
                "key": key,
                "size": size,
                "present": present,
                "manifest": None if manifest_blob is None else validate_manifest(manifest_blob, universe, output),
            }
        )
    return {"file": file, "versions": versions}


def read_version(project: Path, universe: str, output: str, commit: str) -> tuple[str, bytes]:
    """The output file's project-relative path and its bytes at a commit."""
    if not _COMMIT.match(commit):
        raise web.HTTPError(400, "A commit is named by 7 to 40 hexadecimal characters")
    file, _ = output_file(project, universe, output)
    resolved = run_git(project, "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}")
    if resolved.returncode != 0:
        raise web.HTTPError(404, "No such commit in this project", reason="commit")
    name = f"{resolved.stdout.decode('utf-8', 'replace').strip()}:./{file}"
    size = blob_sizes(project, [name])[name]
    if size is None:
        raise web.HTTPError(404, "The output does not exist at this commit", reason="missing")
    if size <= POINTER_MAX_BYTES:
        blob = read_blobs(project, [name]).get(name, b"")
        key = pointer_key(blob)
        return file, blob if key is None else annex_content(project, key)
    if size > MAX_CONTENT_BYTES:
        raise too_large()
    return file, read_blobs(project, [name]).get(name, b"")


def annex_content(project: Path, key: str) -> bytes:
    """The bytes git-annex holds for a key; absent content is a 404 the client can tell apart."""
    recorded = key_size(key)
    if recorded is not None and recorded > MAX_CONTENT_BYTES:
        raise too_large()
    location = content_locations(project, [key])[key]
    if location is None:
        raise web.HTTPError(404, "The bytes of this version are not present locally", reason="absent")
    try:
        if location.stat().st_size > MAX_CONTENT_BYTES:
            raise too_large()
        return location.read_bytes()
    except OSError as error:
        raise web.HTTPError(404, "The bytes of this version are not present locally", reason="absent") from error


def content_type(name: str) -> str:
    """The media type a version is served with, by its extension."""
    return CONTENT_TYPES.get(name.rpartition(".")[2].lower(), DEFAULT_CONTENT_TYPE)


def content_disposition(name: str) -> str:
    """An inline disposition naming the file, in both the ASCII and the RFC 5987 form."""
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


# =============================================================================
# Handlers
# =============================================================================


class OutputVersionsHandler(ProjectAPIHandler):
    """The committed history of one output, read through git off the event loop."""

    unavailable_message = "Output versions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """List the versions, newest first; never cached, since the next run adds one."""
        project = await self.project()
        universe = self.get_query_argument("universe")
        output = self.get_query_argument("output")
        await ensure_results_visible(self, project, universe, output)
        self.finish(await asyncio.to_thread(list_versions, project, universe, output))


class OutputVersionContentHandler(ProjectAPIHandler):
    """The bytes of one output at one commit; cacheable forever, since a commit never changes."""

    unavailable_message = "Output versions require local files"

    @property
    def content_security_policy(self) -> str:
        """Confine any script in the bytes to an opaque origin, as Jupyter's own file route does.

        Recipes and agents write these files, and an SVG or PDF opened on its
        own renders as a document of this origin. The sandbox keeps it from
        acting with the user's session even where a deployment's policy lets
        scripts run.
        """
        return super().content_security_policy + "; sandbox allow-scripts"

    @web.authenticated
    @authorized
    async def get(self):
        """Serve the bytes inline with a media type the browser can render.

        As for ``/files/``, a request without an XSRF token must come from a
        page of this server by its Referer, which refuses cross-site inclusion.
        """
        self.check_xsrf_cookie()
        project = await self.project()
        universe = self.get_query_argument("universe")
        output = self.get_query_argument("output")
        commit = self.get_query_argument("commit")
        await ensure_results_visible(self, project, universe, output)
        file, data = await asyncio.to_thread(read_version, project, universe, output, commit)
        name = PurePosixPath(file).name
        self.set_header("Content-Disposition", content_disposition(name))
        self.set_header("Cache-Control", "private, max-age=31536000, immutable")
        self.set_header("X-Content-Type-Options", "nosniff")
        self.finish(data, set_content_type=content_type(name))

    def write_error(self, status_code, **kwargs):
        """Errors are never immutable: absent content may be fetched later."""
        self.set_header("Cache-Control", "no-store")
        super().write_error(status_code, **kwargs)


def setup_versions_handlers(web_app):
    """Register the listing and content routes under the server base URL, JupyterHub prefixes included."""
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "versions")
    web_app.add_handlers(
        ".*$",
        [
            (api, OutputVersionsHandler),
            (url_path_join(api, "content"), OutputVersionContentHandler),
        ],
    )
