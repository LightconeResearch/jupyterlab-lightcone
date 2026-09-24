"""Small JSON stores a project keeps under `.lightcone/`: read bounded, written whole.

The folder is hidden, so the Contents API refuses it unless the server allows
hidden paths; the stores are therefore read from and written to disk here,
atomically, and the engine's `.gitignore` template already ignores the folder.
"""

import json
import os
from pathlib import Path
import tempfile

from .projects import LIGHTCONE_DIRECTORY


class StoreError(Exception):
    """A store could not be read or written; `status` is the HTTP status it maps to."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def store_path(project: Path, name: str) -> Path:
    """Where a project keeps the store called `name`."""
    return project / LIGHTCONE_DIRECTORY / name


def read_json(path: Path, limit: int):
    """The parsed JSON of a store, or None when there is no store yet.

    Raises `StoreError` (503) when the file exists but cannot be read, and
    `StoreError` (500) when it is larger than `limit` or is not JSON.
    """
    try:
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise StoreError(f"{path.name} could not be read.", 503) from error
    if len(data) > limit:
        raise StoreError(f"{path.name} is larger than {limit} bytes.", 500)
    try:
        return json.loads(data)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise StoreError(f"{path.name} is not JSON.", 500) from error


def write_json(path: Path, payload, limit: int | None = None, **dumps) -> None:
    """Replace a store atomically, so a crash leaves the previous version.

    A payload larger than `limit` is refused with `StoreError` (413) before
    anything is written. Other keyword arguments go to `json.dumps`.
    """
    data = json.dumps(payload, **dumps).encode("utf-8")
    if limit is not None and len(data) > limit:
        raise StoreError(f"{path.name} would exceed {limit} bytes.", 413)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
