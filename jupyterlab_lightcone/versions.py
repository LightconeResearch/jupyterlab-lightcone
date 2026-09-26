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
from .provenance import MAX_RECORD_BYTES, ensure_results_visible, record_path, validate_record
from .results import universe_directory

MAX_VERSIONS = 200
"""How many commits one listing reaches back."""

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
# Tree changes for historical rename tracking
# =============================================================================


def _flat_changes(entry: WalkEntry) -> list:
    """A walk entry's tree changes; a merge lists each parent's changes."""
    changes = entry.changes()
    return [change for group in changes for change in group] if changes and isinstance(changes[0], list) else changes


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


def setup_versions_handlers(web_app):
    """Register the listing and content routes under the server base URL."""
    api = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "versions")
    web_app.add_handlers(
        ".*$",
        [
            (api, OutputVersionsHandler),
            (url_path_join(api, "content"), OutputVersionContentHandler),
        ],
    )
