"""The cluster registry: one directory per cluster under `~/.lightcone/clusters/`.

This module is the writer's half of the contract that `lc materialize` reads
(docs/design/compute-clusters.md states it normatively): where records live,
what a record holds, the TLS material that authenticates every connection, and
the command lines schedulers and workers are started with. The extension is
the only writer; the engine only reads.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import string
import sys
import tempfile

FORMAT = "lightcone.cluster/1"
"""The record format this extension writes; the engine names the one it reads."""

RECORD_FILE = "cluster.json"
SCHEDULER_FILE = "scheduler.json"
"""Written by the Dask scheduler itself (`--scheduler-file`) once it listens."""

TLS_DIRECTORY = "tls"
CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"

WORKER_SCRATCH = "/tmp"
"""Node-local worker scratch, literal for the reason the engine gives: a site
prolog can scope TMPDIR to one node or job step."""

WORKER_DEATH_TIMEOUT = 60
"""Seconds a worker waits for its scheduler, then exits instead of holding a node."""

ENCRYPTION_ENV = {"DASK_DISTRIBUTED__COMM__REQUIRE_ENCRYPTION": "True"}
"""Refuse any unencrypted connection, in every process of a cluster."""

_ID = re.compile(r"[0-9]{8}-[0-9]{6}-[a-z0-9]{4}")
_ID_CHARS = string.ascii_lowercase + string.digits


def registry_root() -> Path:
    """Where cluster directories live: per user, on the filesystem every node sees."""
    return Path.home() / ".lightcone" / "clusters"


def new_cluster_id(now: datetime | None = None) -> str:
    """A sortable, filesystem-safe id: creation time in UTC plus a random suffix."""
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    suffix = "".join(secrets.choice(_ID_CHARS) for _ in range(4))
    return f"{moment:%Y%m%d-%H%M%S}-{suffix}"


def is_cluster_id(value: str) -> bool:
    return _ID.fullmatch(value) is not None


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Record:
    """A cluster directory and the record it holds."""

    directory: Path
    data: dict

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def backend(self) -> str:
        return self.data["backend"]

    def section(self, name: str) -> dict:
        """The backend's own section (`local`, `slurm` or `gateway`); empty if absent."""
        value = self.data.get(name)
        return value if isinstance(value, dict) else {}

    def path(self, relative: str) -> Path:
        return self.directory / relative


def make_directory(root: Path, cluster_id: str) -> Path:
    """Create a cluster's directory, readable by its owner alone."""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    directory = root / cluster_id
    directory.mkdir(mode=0o700)
    return directory


def write_record(record: Record) -> None:
    """Replace the record atomically, so no reader ever sees half of one."""
    _write_private(record.path(RECORD_FILE), json.dumps(record.data, indent=2) + "\n")


def _write_private(path: Path, text: str) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def read_records(root: Path) -> list[Record]:
    """Every readable record of this format, oldest first; anything else is skipped."""
    try:
        directories = sorted(entry for entry in root.iterdir() if is_cluster_id(entry.name))
    except OSError:
        return []
    records = []
    for directory in directories:
        try:
            data = json.loads((directory / RECORD_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("format") == FORMAT and data.get("id") == directory.name:
            records.append(Record(directory, data))
    return records


def remove(record: Record) -> None:
    """Forget a cluster whose backend reports it gone."""
    shutil.rmtree(record.directory, ignore_errors=True)


def write_tls(directory: Path) -> dict:
    """Generate the cluster's key and self-signed certificate, which is also its CA.

    One pair serves every role, as `distributed.Security.temporary` makes it:
    whoever can read these files can join or drive the cluster, which is why
    they are readable by their owner alone.
    """
    from distributed import Security

    generated = Security.temporary()
    tls = directory / TLS_DIRECTORY
    tls.mkdir(mode=0o700)
    _write_private(tls / CERT_FILE, generated.tls_ca_file)
    _write_private(tls / KEY_FILE, generated.tls_client_key)
    cert = f"{TLS_DIRECTORY}/{CERT_FILE}"
    return {"ca": cert, "cert": cert, "key": f"{TLS_DIRECTORY}/{KEY_FILE}"}


def security(record: Record):
    """A client-side `distributed.Security` for the record's TLS files."""
    from distributed import Security

    tls = record.data["tls"]
    return Security(
        tls_ca_file=str(record.path(tls["ca"])),
        tls_client_cert=str(record.path(tls["cert"])),
        tls_client_key=str(record.path(tls["key"])),
        require_encryption=True,
    )


def tls_arguments(record: Record) -> list[str]:
    tls = record.data["tls"]
    return [
        "--tls-ca-file", str(record.path(tls["ca"])),
        "--tls-cert", str(record.path(tls["cert"])),
        "--tls-key", str(record.path(tls["key"])),
    ]


def read_scheduler_file(record: Record) -> dict | None:
    """The scheduler's own connection file, once it listens; None before, or mid-write."""
    try:
        data = json.loads(record.path(SCHEDULER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and isinstance(data.get("address"), str):
        return data
    return None


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def worker_environment(image: str | None = None, interpreter: str | None = sys.executable) -> dict:
    """What workers run: the interpreter and the versions the engine checks on attach.

    Workers started on hosts run this server's interpreter, the installation
    the server's own engine imports; a Gateway cluster's workers run `image`.
    """
    return {
        "interpreter": interpreter,
        "image": image,
        "lightcone": package_version("lightcone-cli"),
        "distributed": package_version("distributed"),
        "python": platform.python_version(),
    }


def scheduler_argv(interpreter: str, record: Record, host: str, idle_timeout: int) -> list[str]:
    """The scheduler of a host-launched cluster: TLS only, writing its scheduler file."""
    return [
        interpreter, "-m", "distributed.cli.dask_scheduler",
        "--scheduler-file", str(record.path(SCHEDULER_FILE)),
        "--host", host,
        "--port", "0",
        "--protocol", "tls",
        "--dashboard-address", f"{host}:0",
        "--idle-timeout", f"{idle_timeout}s",
        *tls_arguments(record),
    ]


def worker_arguments(record: Record) -> list[str]:
    """Every worker flag but the thread count, which the backend knows per host.

    The engine's own contract for workers: one process per host that runs
    recipes in subprocesses, so no nanny (nothing would restart it), no memory
    limit (Dask cannot see the subprocesses' memory, so it could only pause a
    worker over phantom numbers), node-local scratch, and a death timeout so a
    worker whose scheduler is gone releases its node.
    """
    return [
        "-m", "distributed.cli.dask_worker",
        "--scheduler-file", str(record.path(SCHEDULER_FILE)),
        "--protocol", "tls",
        "--nworkers", "1",
        "--no-nanny",
        "--no-dashboard",
        "--memory-limit", "0",
        "--death-timeout", str(WORKER_DEATH_TIMEOUT),
        "--local-directory", WORKER_SCRATCH,
        *tls_arguments(record),
    ]
