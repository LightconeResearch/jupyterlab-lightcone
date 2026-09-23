"""Committed versions of a materialized output: git history and git-annex bytes.

The engine commits every materialization as ``[DATALAD RUNCMD] <output>
[<universe>]`` with the run record in the message, keeps the bytes in
git-annex behind an unlocked pointer file, and writes a manifest sidecar
beside the output. These routes read that history back for one output: the
commits that touched its file, what each of them recorded, and the bytes at
any of them. Nothing here writes to the repository.
"""

import asyncio
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
from pathlib import Path, PurePosixPath

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from tornado import web

from .project_routes import ProjectAPIHandler, contents_call
from .provenance import MAX_RECORD_BYTES, read_record, record_path

MAX_VERSIONS = 200
"""How many commits one listing reaches back."""

MAX_CONTENT_BYTES = 50 * 1024 * 1024
"""The largest version the content route serves."""

GIT_TIMEOUT = 60.0
"""Seconds one git or git-annex command may take."""

POINTER_PREFIX = b"/annex/objects/"
POINTER_MAX_BYTES = 32 * 1024
"""git-annex's own pointer-file rule: at most 32 KiB, starting with the prefix."""

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
_KEY_SIZE = re.compile(r"^[A-Za-z0-9_]+-s(\d+)-")
_UNSAFE_KEY = re.compile(r"[\s/\\\x00-\x1f\x7f]")


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
    """
    manifest = record_path(project, universe, output)
    prefix = f"{output}."
    try:
        with os.scandir(manifest.parent) as entries:
            names = sorted(
                entry.name
                for entry in entries
                if entry.name.startswith(prefix)
                and (entry.is_file(follow_symlinks=False) or entry.is_symlink())
            )
    except FileNotFoundError:
        names = []
    except OSError as error:
        raise web.HTTPError(503, "The results directory could not be read") from error
    if not names:
        raise web.HTTPError(404, "This output has no materialized file")
    chosen = names[0]
    if len(names) > 1:
        preferred = manifest_output_name(manifest)
        if preferred in names:
            chosen = preferred
    directory = PurePosixPath("results", universe)
    return str(directory / chosen), str(directory / manifest.name)


def manifest_output_name(manifest: Path) -> str | None:
    """The file name the manifest on disk records as ``output_path``, if any."""
    try:
        with manifest.open("rb") as stream:
            data = json.loads(stream.read(MAX_RECORD_BYTES))
    except (OSError, ValueError):
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
    committed.
    """
    if run_git(project, "rev-parse", "--verify", "--quiet", "HEAD").returncode != 0:
        return []
    listed = run_git(
        project,
        "log",
        f"--max-count={MAX_VERSIONS}",
        "--follow",
        "--format=%H%x1f%cI%x1f%s%x1f%B%x1e",
        "--",
        file,
    )
    if listed.returncode != 0:
        raise web.HTTPError(503, "git could not list the output's history")
    history = []
    for chunk in listed.stdout.decode("utf-8", "replace").split("\x1e"):
        fields = chunk.strip("\n").split("\x1f", 3)
        if len(fields) != 4:
            continue
        commit, time, subject, body = fields
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
    checked = run_git(project, "cat-file", "--batch-check", stdin="".join(f"{name}\n" for name in names))
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
    read = run_git(project, "cat-file", "--batch", stdin="".join(f"{name}\n" for name in names))
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
    """The annex key an unlocked pointer file names, or None for real content."""
    if len(blob) > POINTER_MAX_BYTES or not blob.startswith(POINTER_PREFIX):
        return None
    # The first line holds the object path; the key is its last segment.
    key = blob.decode("utf-8", "replace").split("\n", 1)[0].strip().rpartition("/")[2]
    return key if key and not _UNSAFE_KEY.search(key) else None


def key_size(key: str) -> int | None:
    """The byte size a key records in its ``-s<size>`` field, when its backend has one."""
    match = _KEY_SIZE.match(key)
    return int(match.group(1)) if match else None


def content_locations(project: Path, keys: list[str]) -> dict[str, Path | None]:
    """Where git-annex holds each key's bytes; None when the content is not here.

    One process for every key: ``contentlocation --batch`` answers a line per
    key and a blank one for content it does not hold. A missing git-annex or a
    repository without an annex answers nothing, which means the same thing.
    """
    locations: dict[str, Path | None] = dict.fromkeys(keys)
    if not keys:
        return locations
    located = run_git(project, "annex", "contentlocation", "--batch", stdin="".join(f"{key}\n" for key in keys))
    for key, line in zip(keys, located.stdout.decode("utf-8", "replace").split("\n")):
        if line.strip():
            locations[key] = project / line.strip()
    return locations


def validate_manifest(blob: bytes, universe: str, output: str) -> dict | None:
    """The manifest as the provenance route would serve it; None when it fails those checks.

    ``read_record`` is the one place the manifest schema is checked, and it
    reads a file, so the blob is handed to it as one.
    """
    if len(blob) > MAX_RECORD_BYTES:
        return None
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch, "manifest.json")
        path.write_bytes(blob)
        try:
            return read_record(path, universe, output)["record"]
        except web.HTTPError:
            return None


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
        raise web.HTTPError(413, "This version is larger than the 50 MiB the viewer serves")
    return file, read_blobs(project, [name]).get(name, b"")


def annex_content(project: Path, key: str) -> bytes:
    """The bytes git-annex holds for a key; absent content is a 404 the client can tell apart."""
    recorded = key_size(key)
    if recorded is not None and recorded > MAX_CONTENT_BYTES:
        raise web.HTTPError(413, "This version is larger than the 50 MiB the viewer serves")
    location = content_locations(project, [key])[key]
    if location is None:
        raise web.HTTPError(404, "The bytes of this version are not present locally", reason="absent")
    try:
        if location.stat().st_size > MAX_CONTENT_BYTES:
            raise web.HTTPError(413, "This version is larger than the 50 MiB the viewer serves")
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


async def visible_results(handler: ProjectAPIHandler, project: Path, universe: str, output: str) -> None:
    """Apply the contents manager's read and hidden-path rules to the results directory.

    The same check the provenance route makes: the sidecars are hidden by
    design, but their directory must be one Jupyter would serve.
    """
    manifest = record_path(project, universe, output)
    if manifest.parent.exists():
        parent = manifest.parent.relative_to(handler.contents_root).as_posix()
        await contents_call(handler.contents_manager.get, parent, content=False, type="directory")


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
        await visible_results(self, project, universe, output)
        self.finish(await asyncio.to_thread(list_versions, project, universe, output))


class OutputVersionContentHandler(ProjectAPIHandler):
    """The bytes of one output at one commit; cacheable forever, since a commit never changes."""

    unavailable_message = "Output versions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Serve the bytes inline with a media type the browser can render."""
        project = await self.project()
        universe = self.get_query_argument("universe")
        output = self.get_query_argument("output")
        commit = self.get_query_argument("commit")
        await visible_results(self, project, universe, output)
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
