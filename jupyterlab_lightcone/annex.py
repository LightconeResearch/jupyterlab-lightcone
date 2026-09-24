"""git-annex, asked about the bytes of committed outputs.

git holds a pointer for an annexed file; git-annex holds the bytes and knows
which repositories have them. This module asks git-annex the questions the
version routes need, through its own commands and JSON, and nothing else:
which key a tree entry names, how large the key's content is, where its bytes
are, and the path of the bytes here. It never spells a pointer, a key or an
object path itself, and reads only.

Every git-annex command initializes a clone on first use and may merge fetched
``git-annex`` branches or upgrade the repository before answering; the reads
here run with both turned off, and a repository git-annex has not initialized
(no ``annex.uuid``, the mark ``git annex init`` leaves) is never asked.

git-annex itself comes with the extension: the ``git-annex`` wheel is a
dependency, and installs the executable beside this interpreter's scripts,
where ``projects.expose_engine_tools`` puts it on ``PATH`` at load.
"""

import json
from pathlib import Path
import shutil
import subprocess

ANNEX_TIMEOUT = 60.0
"""Seconds one git-annex command may take."""

READ_ONLY = ("-c", "annex.autoupgraderepository=false", "-c", "annex.merge-annex-branches=false")
"""The two things git-annex would otherwise do to the repository before answering a read."""


class AnnexUnavailable(Exception):
    """git-annex could not be run: git or git-annex is missing, or a command hung."""


def _run(repository: Path, *arguments: str, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    """Run one git-annex command in the repository; a nonzero exit is the caller's to read.

    ``git annex`` is git finding a ``git-annex`` executable on ``PATH``, so
    its absence is checked first: git would otherwise exit with "not a git
    command" and an empty answer, which no caller may mistake for "nothing
    annexed".
    """
    if shutil.which("git-annex") is None:
        raise AnnexUnavailable("git-annex is required to read annexed content and is not on the server's PATH")
    try:
        completed = subprocess.run(
            ["git", *READ_ONLY, "annex", *arguments],
            cwd=repository,
            capture_output=True,
            input=stdin,
            timeout=ANNEX_TIMEOUT,
            check=False,
        )
    except FileNotFoundError as error:
        raise AnnexUnavailable("git is required to read annexed content") from error
    except subprocess.TimeoutExpired as error:
        raise AnnexUnavailable("git-annex did not answer in time") from error
    if b"is not a git command" in completed.stderr:
        raise AnnexUnavailable("git cannot run git-annex on this server")
    return completed


def _lines(items: list[str]) -> bytes:
    """One request per line for a ``--batch`` command; a caller never sends a line break."""
    if any("\n" in item or "\r" in item for item in items):
        raise ValueError("A git-annex batch request is one line")
    return "".join(f"{item}\n" for item in items).encode("utf-8", "surrogateescape")


def initialized(repository: Path) -> bool:
    """Whether git-annex has initialized this repository: ``annex.uuid`` is the mark it leaves."""
    try:
        completed = subprocess.run(
            ["git", "config", "--get", "annex.uuid"],
            cwd=repository,
            capture_output=True,
            timeout=ANNEX_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0 and bool(completed.stdout.strip())


def lookup_keys(repository: Path, refs: list[str]) -> dict[str, str | None]:
    """The annex key each ``<commit>:<path>`` tree entry names; None where git holds the bytes.

    ``lookupkey --ref`` reads the entry as git-annex itself does, whether it is
    an unlocked pointer or a locked symlink, and answers one line per request,
    blank when the entry is not annexed.
    """
    if not refs:
        return {}
    completed = _run(repository, "lookupkey", "--ref", "--batch", stdin=_lines(refs))
    answers = completed.stdout.decode("utf-8", "replace").split("\n")
    return {ref: (answers[index].strip() or None) if index < len(answers) else None for index, ref in enumerate(refs)}


def sizes(repository: Path, keys: list[str]) -> dict[str, int | None]:
    """The byte size each key records, as ``examinekey`` reports it; None when it records none."""
    result: dict[str, int | None] = dict.fromkeys(keys)
    if not keys:
        return result
    completed = _run(repository, "examinekey", "--batch", "--json", stdin=_lines(keys))
    for line in completed.stdout.decode("utf-8", "replace").splitlines():
        info = _json_object(line)
        key, size = info.get("key"), info.get("bytesize")
        if isinstance(key, str) and key in result and isinstance(size, str) and size.isdigit():
            result[key] = int(size)
    return result


def whereis(repository: Path, keys: list[str]) -> dict[str, dict]:
    """Where each key's bytes are: whether they are here, and which other repositories hold them.

    ``whereis --json`` lists every repository holding a copy, with the
    description each was given; ``here`` marks this one.
    """
    result = {key: {"key": key, "here": False, "remotes": []} for key in keys}
    if not keys:
        return result
    completed = _run(repository, "whereis", "--batch-keys", "--json", stdin=_lines(keys))
    for line in completed.stdout.decode("utf-8", "replace").splitlines():
        info = _json_object(line)
        key = info.get("key")
        if not isinstance(key, str) or key not in result:
            continue
        places = [place for place in (info.get("whereis") or []) if isinstance(place, dict)]
        result[key] = {
            "key": key,
            "here": any(place.get("here") is True for place in places),
            "remotes": [
                place["description"]
                for place in places
                if place.get("here") is not True and isinstance(place.get("description"), str)
            ],
        }
    return result


def content_path(repository: Path, key: str) -> Path | None:
    """The file holding a key's bytes in this repository, or None when they are not here."""
    completed = _run(repository, "contentlocation", key)
    location = completed.stdout.decode("utf-8", "surrogateescape").strip()
    return repository / location if completed.returncode == 0 and location else None


def _json_object(line: str) -> dict:
    try:
        value = json.loads(line)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
