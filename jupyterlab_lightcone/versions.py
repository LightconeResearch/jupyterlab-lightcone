"""Committed versions of a materialized output, read from the project's git history.

The engine commits every materialization with its output file and a manifest
sidecar under ``results/``, and keeps the bytes of the output in git-annex
behind a pointer. These routes read the history back for one output: the
commits that touched its file, the manifest each of them recorded, and the
bytes at any of them. History and everything git holds are read with dulwich,
in process; what git-annex holds is asked of git-annex itself (``annex.py``),
so no pointer, key or object path is ever spelled here. Nothing writes to the
repository.
"""

import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tomllib
import urllib.parse

from dulwich.errors import NotGitRepository
from dulwich.diff_tree import RENAME_CHANGE_TYPES
from dulwich.object_store import tree_lookup_path
from dulwich.objects import Blob, Commit, Tree
from dulwich.repo import Repo
from dulwich.walk import WalkEntry
from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from lightcone.engine import plan
from lightcone.engine.project import ProjectError
from tornado import web
from tornado.iostream import StreamClosedError

from . import annex
from .project_routes import ProjectAPIHandler
from .provenance import MAX_RECORD_BYTES, ensure_results_visible, record_path, validate_output_identity, validate_record
from .results import MANIFEST_SUFFIX, RESULTS_DIRECTORY, universe_directory

MAX_VERSIONS = 200
"""How many commits one listing reaches back."""

MAX_RESULTS_COMMITS = 200
"""How many commits touching ``results/`` one history request lists."""

MAX_CONTENT_BYTES = 50 * 1024 * 1024
"""The largest version the content route serves."""

CONTENT_CHUNK_SIZE = 1024 * 1024
"""How much of an annexed version is read and sent at a time."""

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

MAX_SOURCE_BYTES = 1024 * 1024
"""The largest script the source route returns as text."""

MAX_LOCK_BYTES = 8 * 1024 * 1024
"""The largest ``uv.lock`` the packages route parses."""

MAX_SOURCE_PATH = 1024
"""The longest project-relative path the source route accepts."""

COMMIT_NAME = re.compile(r"[0-9a-f]{7,40}|[0-9a-f]{64}")
"""A commit as the routes and the agent's tools accept it, in lower case: abbreviated, or any full name listed."""


# =============================================================================
# The repository
# =============================================================================


class Repository:
    """A project's repository, and where the project sits in its work tree.

    A project may be a repository of its own or a folder inside a larger one
    (``lc init subdir/`` adopts an enclosing work tree), so every path the
    routes name is project-relative and is prefixed here.
    """

    def __init__(self, repo: Repo, prefix: PurePosixPath):
        self.repo = repo
        self.prefix = prefix
        self.root = Path(repo.path)

    def annex_state(self) -> str:
        """``initialized`` when git-annex works here, ``uninitialized`` in a clone of an
        annexed repository nobody ran ``git annex init`` in, ``none`` in a plain repository.

        ``annex.uuid`` in the repository's own configuration is the mark
        ``git annex init`` leaves. The ``git-annex`` branch is where git-annex
        keeps its state, so its presence in any ref is what tells an
        uninitialized clone from a repository that never had an annex. An
        uninitialized clone is never asked: any git-annex command would
        initialize it.
        """
        try:
            self.repo.get_config().get((b"annex",), b"uuid")
        except KeyError:
            pass
        else:
            return "initialized"
        if any(name.endswith(b"/git-annex") for name in self.repo.refs.allkeys()):
            return "uninitialized"
        return "none"

    def tree_ref(self, commit: Commit, file: str) -> str:
        """``<commit>:<path>`` as git-annex's ``lookupkey --ref`` names a tree entry."""
        return f"{commit.id.decode('ascii')}:{self.path(file).decode('utf-8', 'surrogateescape')}"

    def close(self) -> None:
        """Release the repository's object store and pack files."""
        self.repo.close()

    def path(self, file: str) -> bytes:
        """A project-relative POSIX path as git names it in the tree."""
        return (self.prefix / file).as_posix().encode("utf-8", "surrogateescape")

    def head(self) -> Commit | None:
        """The commit ``HEAD`` names; None before the first commit."""
        try:
            return self.commit(self.repo.head())
        except KeyError:
            return None

    def commit(self, name: bytes) -> Commit | None:
        """The commit an object name refers to; None for another kind of object."""
        found = self.repo[name]
        return found if isinstance(found, Commit) else None

    def resolve(self, commit: str) -> Commit:
        """The commit 7 to 40 hexadecimal characters name, or 64, in either case; a 400 or 404 otherwise."""
        if not isinstance(commit, str) or not COMMIT_NAME.fullmatch(commit.lower()):
            raise web.HTTPError(400, "A commit is named by 7 to 40 hexadecimal characters, or 64")
        name = commit.lower().encode("ascii")
        if len(commit) in (40, 64):
            try:
                found = self.commit(name)
            except KeyError:
                found = None
        else:
            matches = [self.commit(candidate) for candidate in self.repo.object_store.iter_prefix(name)]
            commits = [match for match in matches if match is not None]
            found = commits[0] if len(commits) == 1 else None
        if found is None:
            raise web.HTTPError(404, "No such commit in this project", reason="commit")
        return found

    def entry(self, commit: Commit, file: str) -> tuple[int, Blob] | None:
        """The mode and blob a commit holds at a project-relative path; None when absent.

        Files and symlinks are both blobs in a tree; directories and
        submodules are not files and count as absent.
        """
        try:
            mode, sha = tree_lookup_path(self.repo.__getitem__, commit.tree, self.path(file))
        except KeyError:
            return None
        if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            return None
        blob = self.repo[sha]
        return (mode, blob) if isinstance(blob, Blob) else None

    def names(self, commit: Commit, directory: str) -> list[str]:
        """The file and symlink names a commit holds in a project-relative directory."""
        try:
            mode, sha = tree_lookup_path(self.repo.__getitem__, commit.tree, self.path(directory))
        except KeyError:
            return []
        tree = self.repo[sha] if stat.S_ISDIR(mode) else None
        if not isinstance(tree, Tree):
            return []
        return [
            name.decode("utf-8", "surrogateescape")
            for name, item_mode, _ in tree.iteritems()
            if stat.S_ISREG(item_mode) or stat.S_ISLNK(item_mode)
        ]

    def walk(self, paths: list[str], **options):
        """The commits reachable from ``HEAD`` that touched any of the paths, newest first."""
        head = self.head()
        if head is None:
            return []
        return self.repo.get_walker(include=[head.id], paths=[self.path(path) for path in paths], **options)

    def previous_file(self, entry: WalkEntry, file: str) -> str | None:
        """The file's name before this commit's rename, confined to this project.

        The rename commit itself holds the new path; only older revisions
        use the old path. Use the walker's detected renames, as ``follow`` does.
        """
        for change in _flat_changes(entry):
            if change is not None and change.type in RENAME_CHANGE_TYPES and change.new.path == self.path(file):
                old = PurePosixPath(change.old.path.decode("utf-8", "surrogateescape"))
                return old.relative_to(self.prefix).as_posix() if old.is_relative_to(self.prefix) else None
        return file


def open_repository(project: Path) -> Repository | None:
    """The repository holding the project; None when it is outside every repository."""
    try:
        repo = Repo.discover(str(project))
    except NotGitRepository:
        return None
    try:
        prefix = project.resolve().relative_to(Path(repo.path).resolve())
    except ValueError:
        repo.close()
        return None
    return Repository(repo, PurePosixPath(prefix.as_posix()))


def require_repository(project: Path) -> Repository:
    """The project's repository, or the 404 the routes answer outside one."""
    repository = open_repository(project)
    if repository is None:
        raise web.HTTPError(404, "This project is not in a git repository", reason="repository")
    return repository


def commit_time(commit: Commit) -> str:
    """The commit time as ISO 8601 with its recorded offset."""
    zone = timezone(timedelta(seconds=commit.commit_timezone))
    return datetime.fromtimestamp(commit.commit_time, zone).isoformat()


def commit_subject(commit: Commit) -> str:
    """The first line of the commit message."""
    return commit.message.decode("utf-8", "replace").split("\n", 1)[0]


def describe_commit(commit: Commit) -> dict:
    """The fields every listing gives for a commit."""
    name = commit.id.decode("ascii")
    return {"commit": name, "short": name[:7], "time": commit_time(commit), "subject": commit_subject(commit)}


# =============================================================================
# The output file
# =============================================================================


def declared_output(project: Path, universe: str, output: str) -> str | None:
    """The project-relative file the spec declares for an output; None when it declares no such output.

    The engine composes the file's name from the declared format, so its plan
    is asked rather than the results folder. Raises ``ProjectError`` when the
    spec or its universes cannot be read.
    """
    task = plan.build(project).tasks.get((universe, output))
    return task.output_path.relative_to(project).as_posix() if task is not None else None


def output_file(project: Path, universe: str, output: str, repository: Repository | None) -> tuple[str, str]:
    """Locate the materialized file and its sidecar, as project-relative POSIX paths.

    The spec names the file (``declared_output``), so a run that is deleting
    and rebuilding it, or a stale file a re-declared format left behind,
    changes nothing. An output the spec no longer declares, or a spec that
    cannot be read, still has its committed history: the last commit then
    names the file as ``results/<universe>/<output>.*``, the first name
    alphabetically when several remain. Symlinks count, since a locked annex
    file without its content is a dangling one. With neither, an unreadable
    spec is the answer (422); otherwise the output has no file (404).
    """
    manifest = record_path(project, universe, output)
    directory = universe_directory(universe)
    problem = None
    try:
        file = declared_output(project, universe, output)
    except ProjectError as error:
        file, problem = None, error
    if file is None and repository is not None:
        head = repository.head()
        names = repository.names(head, directory.as_posix()) if head is not None else []
        committed = sorted(name for name in names if name.startswith(f"{output}."))
        if committed:
            file = str(directory / committed[0])
    if file is None:
        if problem is not None:
            # The client is sent log_message unformatted, so it carries no arguments.
            raise web.HTTPError(422, f"Lightcone could not read this project's specification:\n{problem}") from problem
        raise web.HTTPError(404, "This output has no materialized file")
    return file, str(directory / manifest.name)


# =============================================================================
# The two answers: the listing and the bytes
# =============================================================================


def validate_manifest(blob: bytes, universe: str, output: str) -> dict | None:
    """The manifest as the provenance route would serve it; None when it fails those checks."""
    try:
        return validate_record(blob, universe, output)
    except ValueError:
        return None


def too_large() -> web.HTTPError:
    """The refusal of a version beyond what the content route serves, naming the limit."""
    mebibyte = 1024 * 1024
    if MAX_CONTENT_BYTES % mebibyte == 0:
        limit = f"{MAX_CONTENT_BYTES // mebibyte} MiB"
    else:
        limit = f"{MAX_CONTENT_BYTES} bytes"
    return web.HTTPError(413, f"This version is larger than the {limit} the viewer serves")


def read_manifest(repository: Repository, commit: Commit, manifest: str, universe: str, output: str) -> dict | None:
    """The manifest sidecar at a commit, when valid."""
    sidecar = repository.entry(commit, manifest)
    if sidecar is None or len(sidecar[1].data) > MAX_RECORD_BYTES:
        return None
    return validate_manifest(sidecar[1].data, universe, output)


def list_versions(project: Path, universe: str, output: str) -> dict:
    """Every committed version of an output, newest first, with what each commit recorded.

    A folder that is not a repository, or one without a commit yet, has no
    history rather than an error: the output may simply never have been
    committed. The file is followed across renames. Each version says where
    its bytes are: in git (``present`` with a ``size``), or in git-annex
    (``annex`` names the key, whether the bytes are here and which other
    repositories hold them). In an uninitialized clone nothing can be asked,
    and the listing's ``annex`` state says so.
    """
    repository = open_repository(project)
    try:
        file, manifest = output_file(project, universe, output, repository)
        if repository is None:
            return {"file": file, "annex": "none", "versions": []}
        state = repository.annex_state()
        history = []
        historical_file = file
        for entry in repository.walk([file], follow=True, max_entries=MAX_VERSIONS):
            history.append((entry.commit, historical_file, repository.entry(entry.commit, historical_file)))
            historical_file = repository.previous_file(entry, historical_file)
            if historical_file is None:
                break
        refs = [repository.tree_ref(commit, path) for commit, path, entry in history if entry is not None]
        keys = annex.lookup_keys(repository.root, refs) if state == "initialized" else {}
        distinct = sorted({key for key in keys.values() if key})
        places, sizes = annex.whereis(repository.root, distinct), annex.sizes(repository.root, distinct)
        versions = []
        for commit, path, entry in history:
            key = keys.get(repository.tree_ref(commit, path)) if entry is not None else None
            if entry is None or state == "uninitialized":
                size, present, held = None, False, None
            elif key:
                size, present, held = sizes.get(key), places[key]["here"], places[key]
            else:
                size, present, held = len(entry[1].data), True, None
            versions.append({
                **describe_commit(commit),
                "file": path,
                "size": size,
                "present": present,
                "annex": held,
                "manifest": read_manifest(repository, commit, manifest, universe, output),
            })
        return {"file": file, "annex": state, "versions": versions}
    finally:
        if repository is not None:
            repository.close()


def read_version(project: Path, universe: str, output: str, commit: str) -> tuple[str, bytes | Path]:
    """The output file's project-relative path and its content at a commit.

    The content is the bytes when git holds them, and the path of the file
    holding them here when git-annex does, for the route to stream.
    """
    repository = require_repository(project)
    try:
        file, _ = output_file(project, universe, output, repository)
        resolved = repository.resolve(commit)
        # Undo only renames after the requested revision, including when the
        # revision did not change this file. Content reads are not limited by
        # the number of versions the listing displays.
        for change in repository.walk([file], follow=True, exclude=[resolved.id]):
            file = repository.previous_file(change, file)
            if file is None:
                break
        entry = repository.entry(resolved, file) if file is not None else None
        if entry is None:
            raise web.HTTPError(404, "The output does not exist at this commit", reason="missing")
        state = repository.annex_state()
        if state == "uninitialized":
            raise web.HTTPError(
                404,
                "git-annex is not initialized in this repository, so its bytes cannot be read (git annex init)",
                reason="absent",
            )
        ref = repository.tree_ref(resolved, file)
        key = annex.lookup_keys(repository.root, [ref])[ref] if state == "initialized" else None
        if key is None:
            data = entry[1].data
            if len(data) > MAX_CONTENT_BYTES:
                raise too_large()
            return file, data
        size = annex.sizes(repository.root, [key])[key]
        if size is not None and size > MAX_CONTENT_BYTES:
            raise too_large()
        location = annex.content_path(repository.root, key)
        if location is None:
            remotes = annex.whereis(repository.root, [key])[key]["remotes"]
            held = ""
            if remotes:
                held = f"; {', '.join(remotes)} {'has' if len(remotes) == 1 else 'have'} a copy (git annex get)"
            raise web.HTTPError(404, f"The bytes of this version are not in this repository{held}", reason="absent")
        try:
            if location.stat().st_size > MAX_CONTENT_BYTES:
                raise too_large()
        except OSError as error:
            raise web.HTTPError(404, "The bytes of this version are not in this repository", reason="absent") from error
        return file, location
    finally:
        repository.close()


def content_type(name: str) -> str:
    """The media type a version is served with, by its extension."""
    return CONTENT_TYPES.get(name.rpartition(".")[2].lower(), DEFAULT_CONTENT_TYPE)


def content_disposition(name: str) -> str:
    """An inline disposition naming the file, in both the ASCII and the RFC 5987 form."""
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


# =============================================================================
# Commits touching results: what a run made, and when
# =============================================================================


def output_identity(path: bytes) -> tuple[str, str] | None:
    """The ``(universe, output)`` a path under ``results/`` belongs to, if any.

    A materialization commits ``results/<universe>/<output>.<ext>`` with its
    sidecar ``results/<universe>/.<output>.manifest.json``; an output id has no
    dot, so either name gives it back. Anything else under ``results/`` (a
    README, a nested folder's file, a name no output could have) is not an
    output.
    """
    parts = path.decode("utf-8", "replace").split("/")
    if len(parts) != 3 or parts[0] != RESULTS_DIRECTORY:
        return None
    universe, name = parts[1], parts[2]
    if name.startswith("."):
        if not name.endswith(MANIFEST_SUFFIX):
            return None
        output = name[1 : -len(MANIFEST_SUFFIX)]
    else:
        output = name.partition(".")[0]
    try:
        validate_output_identity(universe, output)
    except web.HTTPError:
        return None
    return universe, output


def _flat_changes(entry: WalkEntry) -> list:
    """A walk entry's tree changes; a merge lists each parent's changes."""
    changes = entry.changes()
    return [change for group in changes for change in group] if changes and isinstance(changes[0], list) else changes


def _changed_paths(entry) -> list[bytes]:
    """Every path a walk entry's commit changed; a merge lists each parent's changes."""
    paths = []
    for change in _flat_changes(entry):
        for side in (change.new, change.old):
            if side is not None and side.path is not None:
                paths.append(side.path)
    return paths


def results_commits(
    project: Path, since: int | None = None, until: int | None = None, limit: int = MAX_RESULTS_COMMITS
) -> list[dict]:
    """The commits that touched the project's ``results/``, newest first, with the outputs each changed.

    Bounded by commit time when ``since`` and ``until`` (seconds since the
    epoch) are given, so a chat can ask what a reply materialized. A project
    outside git, or before its first commit, has none.
    """
    repository = open_repository(project)
    if repository is None:
        return []
    try:
        listed = []
        results = repository.path(RESULTS_DIRECTORY)
        prefix = len(results) - len(RESULTS_DIRECTORY.encode())
        for entry in repository.walk([RESULTS_DIRECTORY], since=since, until=until, max_entries=limit):
            outputs = []
            # A commit may touch more than this project's results; only those count.
            for path in _changed_paths(entry):
                if not path.startswith(results + b"/"):
                    continue
                identity = output_identity(path[prefix:])
                if identity is not None and identity not in outputs:
                    outputs.append(identity)
            listed.append({
                **describe_commit(entry.commit),
                "outputs": [{"universe": universe, "output": output} for universe, output in outputs],
            })
        return listed
    finally:
        repository.close()


# =============================================================================
# The recorded revision: scripts and the locked environment
# =============================================================================


def validate_source_path(file, allow_hidden: bool) -> str:
    """A project-relative POSIX path that stays inside the project and is not hidden.

    The contents manager refuses hidden files unless the server allows them;
    history must not become a way around that rule.
    """
    if not isinstance(file, str) or not file or len(file) > MAX_SOURCE_PATH or "\\" in file or "\x00" in file:
        raise web.HTTPError(400, "A project-relative file path is required")
    parts = file.split("/")
    if file.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise web.HTTPError(400, "A project-relative file path is required")
    if not allow_hidden and any(part.startswith(".") for part in parts):
        raise web.HTTPError(403, "Hidden files are not available on this server")
    return file


def read_source(project: Path, commit: str, file: str) -> dict:
    """A text file as the project held it at a commit: the script a run executed.

    ``text`` is None when the file did not exist then, is larger than
    ``MAX_SOURCE_BYTES`` (``truncated``), is not UTF-8 text (``binary``) or is
    an annexed file (``annexed``), whose bytes are data rather than code.
    """
    repository = require_repository(project)
    try:
        resolved = repository.resolve(commit)
        answer = {
            "file": file,
            "commit": resolved.id.decode("ascii"),
            "exists": False,
            "text": None,
            "binary": False,
            "annexed": False,
            "truncated": False,
        }
        entry = repository.entry(resolved, file)
        if entry is None:
            return answer
        answer["exists"] = True
        mode, blob = entry
        if repository.annex_state() == "initialized":
            ref = repository.tree_ref(resolved, file)
            if annex.lookup_keys(repository.root, [ref])[ref] is not None:
                answer["annexed"] = True
                return answer
        if len(blob.data) > MAX_SOURCE_BYTES:
            answer["truncated"] = True
            return answer
        if b"\x00" in blob.data:
            answer["binary"] = True
            return answer
        try:
            answer["text"] = blob.data.decode("utf-8")
        except UnicodeDecodeError:
            answer["binary"] = True
        return answer
    finally:
        repository.close()


def parse_lock_packages(data: bytes) -> list[dict] | None:
    """The packages a ``uv.lock`` pins, sorted by name; None when it is not a lock.

    Each entry is ``{"name", "version"}``; packages without a version have a
    null version. A universal lock can pin several versions of the same
    package for different Python versions or platforms. Keep every distinct
    name/version pair, without claiming which one a particular run installed.
    """
    try:
        lock = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None
    packages = lock.get("package")
    if not isinstance(packages, list):
        return None
    pinned: set[tuple[str, str | None]] = set()
    for package in packages:
        if not isinstance(package, dict) or not isinstance(package.get("name"), str):
            continue
        version = package.get("version")
        pinned.add((package["name"], version if isinstance(version, str) else None))
    return [
        {"name": name, "version": version}
        for name, version in sorted(pinned, key=lambda item: (item[0], item[1] or ""))
    ]


def locked_packages(project: Path, commit: str) -> dict:
    """The environment a run was locked to, and the one locked now, from ``uv.lock``.

    ``packages`` is the lock at the commit and ``current`` the lock in the
    working tree; either is None when that lock is absent, oversized or
    unreadable.
    """
    repository = require_repository(project)
    try:
        resolved = repository.resolve(commit)
        entry = repository.entry(resolved, "uv.lock")
        packages = None
        if entry is not None and len(entry[1].data) <= MAX_LOCK_BYTES:
            packages = parse_lock_packages(entry[1].data)
    finally:
        repository.close()
    current = None
    lock = project / "uv.lock"
    try:
        # A visible lock path must not turn project authorization into a
        # read of another project or a file outside the server root.
        if lock.resolve().is_relative_to(project.resolve()) and lock.is_file() and lock.stat().st_size <= MAX_LOCK_BYTES:
            current = parse_lock_packages(lock.read_bytes())
    except OSError:
        current = None
    return {"commit": resolved.id.decode("ascii"), "packages": packages, "current": current}


# =============================================================================
# Handlers
# =============================================================================


async def in_thread(function, *args):
    """Run a history read off the event loop.

    A missing or hung git-annex and a repository the filesystem will not read
    are the service's failures (503). dulwich signals a missing object or a
    bad name where ``Repository`` turns them into None or a 404; anything
    else it raises is a defect, and is reported as one.
    """
    try:
        return await asyncio.to_thread(function, *args)
    except annex.AnnexUnavailable as error:
        raise web.HTTPError(503, str(error)) from error
    except OSError as error:
        raise web.HTTPError(503, "The project's git history could not be read") from error


class OutputVersionsHandler(ProjectAPIHandler):
    """The committed history of one output, read off the event loop."""

    unavailable_message = "Output versions require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """List the versions, newest first; never cached, since the next run adds one."""
        project = await self.project()
        universe = self.get_query_argument("universe")
        output = self.get_query_argument("output")
        await ensure_results_visible(self, project, universe, output)
        self.finish(await in_thread(list_versions, project, universe, output))


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
        # The policy jupyter_server.files.handlers.FilesHandler.content_security_policy applies to /files/.
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
        file, content = await in_thread(read_version, project, universe, output, commit)
        name = PurePosixPath(file).name
        self.set_header("Content-Disposition", content_disposition(name))
        self.set_header("Cache-Control", "private, max-age=31536000, immutable")
        self.set_header("X-Content-Type-Options", "nosniff")
        if isinstance(content, bytes):
            self.finish(content, set_content_type=content_type(name))
        else:
            await self.stream(content, content_type(name))

    async def stream(self, location: Path, media_type: str) -> None:
        """Send an annexed file in chunks read off the event loop, so a large version is never held whole."""
        try:
            stream = await asyncio.to_thread(location.open, "rb")
        except OSError as error:
            raise web.HTTPError(404, "The bytes of this version are not in this repository", reason="absent") from error
        with stream:
            self.set_header("Content-Type", media_type)
            self.set_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
            try:
                while chunk := await asyncio.to_thread(stream.read, CONTENT_CHUNK_SIZE):
                    self.write(chunk)
                    await self.flush()
            except StreamClosedError:
                return
        self.finish(set_content_type=media_type)

    def write_error(self, status_code, **kwargs):
        """Errors are never immutable: absent content may be fetched later."""
        self.set_header("Cache-Control", "no-store")
        super().write_error(status_code, **kwargs)


class ResultsHistoryHandler(ProjectAPIHandler):
    """The commits that touched the project's results, for a window of time."""

    unavailable_message = "Result history requires local files"

    def _whole_number(self, name: str, what: str) -> int | None:
        """An optional query argument that must be a whole number of ``what``; None when absent."""
        value = self.get_query_argument(name, None)
        if value is None:
            return None
        if not value.isdigit():
            raise web.HTTPError(400, f"{name} must be a whole number of {what}")
        return int(value)

    @web.authenticated
    @authorized
    async def get(self):
        """``?path=&since=&until=&limit=`` → ``{"commits": [...]}``, newest first."""
        project = await self.project()
        since = self._whole_number("since", "seconds since the epoch")
        until = self._whole_number("until", "seconds since the epoch")
        limit = self._whole_number("limit", "commits")
        if limit is None:
            limit = MAX_RESULTS_COMMITS
        if not 1 <= limit <= MAX_RESULTS_COMMITS:
            raise web.HTTPError(400, f"limit must be between 1 and {MAX_RESULTS_COMMITS}")
        self.finish({"commits": await in_thread(results_commits, project, since, until, limit)})


class RevisionSourceHandler(ProjectAPIHandler):
    """A project file as a recorded revision held it, for a run's Code tab."""

    unavailable_message = "Recorded code requires local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Return the file's text at the commit, or say why it cannot be shown."""
        project = await self.project()
        commit = self.get_query_argument("commit")
        file = validate_source_path(self.get_query_argument("file"), self.contents_manager.allow_hidden)
        self.finish(await in_thread(read_source, project, commit, file))


class LockedPackagesHandler(ProjectAPIHandler):
    """The packages ``uv.lock`` pinned at a commit, beside today's, for a run's Environment tab."""

    unavailable_message = "Recorded environments require local files"

    @web.authenticated
    @authorized
    async def get(self):
        """Return both package lists; either is null when its lock cannot be read."""
        project = await self.project()
        commit = self.get_query_argument("commit")
        self.finish(await in_thread(locked_packages, project, commit))


def setup_versions_handlers(web_app):
    """Register the listing, content, results, source and packages routes under the server base URL."""
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "versions")
    web_app.add_handlers(
        ".*$",
        [
            (api, OutputVersionsHandler),
            (url_path_join(api, "content"), OutputVersionContentHandler),
            (url_path_join(api, "results"), ResultsHistoryHandler),
            (url_path_join(api, "source"), RevisionSourceHandler),
            (url_path_join(api, "packages"), LockedPackagesHandler),
        ],
    )
