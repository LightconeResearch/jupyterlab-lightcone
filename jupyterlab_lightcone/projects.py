"""Locate local Lightcone projects and drive them through the installed CLI."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import tempfile

from packaging.version import InvalidVersion, Version
from tornado.web import HTTPError


def inside_root(root: Path, candidate: Path, message: str) -> Path:
    """Resolve symlinks first, then refuse anything outside `root`."""
    root = root.resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root):
        raise HTTPError(403, message)
    return resolved


def project_root(root: Path, path: str) -> Path:
    """Resolve only a local ASTRA entrypoint within the contents root."""
    if not path or path.startswith("/") or "\\" in path or ":" in path:
        raise HTTPError(400, "A local astra.yaml path is required")
    if ".." in path.split("/") or Path(path).name != "astra.yaml":
        raise HTTPError(400, "A local astra.yaml path is required")
    return inside_root(root, Path(path), "Project is outside the contents root").parent


def project_path(root: Path, value: str) -> Path:
    """Resolve an entered directory within the server's filesystem boundary."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise HTTPError(400, "Enter a project folder.")
    try:
        candidate = Path(value.strip()).expanduser()
    except RuntimeError as error:
        raise HTTPError(400, "Could not resolve that home directory. Enter a valid project folder.") from error
    if ":" in value:
        raise HTTPError(400, "Project setup supports the local Jupyter drive only.")
    if ".." in candidate.parts:
        raise HTTPError(400, "Parent-directory traversal is not supported.")
    candidate = inside_root(root, candidate, "Choose a folder inside this Jupyter server's root directory.")
    if candidate.exists() and not candidate.is_dir():
        raise HTTPError(400, "The project path is a file. Choose a folder.")
    # A spec symlink must not let a project escape the server root either.
    inside_root(root, candidate / "astra.yaml", "The project specification points outside the server root.")
    return candidate


def describe_project(root: Path, project: Path) -> dict:
    """Return both the display path and Jupyter Contents path."""
    relative = project.relative_to(root.resolve()).as_posix()
    path = "" if relative == "." else relative
    spec = project / "astra.yaml"
    if spec.exists() and not spec.is_file():
        raise HTTPError(400, "astra.yaml is not a file.")
    return {
        "path": path,
        "directory": str(project),
        "entrypoint": f"{path}/astra.yaml" if path else "astra.yaml",
        "hasSpec": spec.is_file(),
    }


def _tail(stream, limit: int = 32768) -> str:
    """Decode the end of a captured stream; install logs can be very long."""
    stream.seek(0, os.SEEK_END)
    stream.seek(max(0, stream.tell() - limit))
    return stream.read().decode("utf-8", errors="replace")


async def run_cli(
    *args: str,
    operation: str,
    timeout_message: str,
    timeout: float = 180,
    cwd: Path | None = None,
    failure_status: int = 400,
) -> str:
    """Run a fixed CLI invocation without a shell; bound its time and error logs.

    Every Lightcone endpoint reaches the CLI through here. The caller words its
    own failures: `operation` completes "Lightcone could not ...", and
    `timeout_message` is shown when the time limit is reached.
    """
    executable = shutil.which("lc")
    if not executable:
        raise HTTPError(503, "Lightcone CLI is not installed in the Jupyter server environment. Install a supported lightcone-cli release.")
    # A file avoids accumulating unbounded dependency-install output in memory.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            process = await asyncio.create_subprocess_exec(
                executable, *args, stdout=output, stderr=errors, cwd=cwd,
                start_new_session=True,
            )
        except OSError as error:
            raise HTTPError(503, "Lightcone CLI could not be started.") from error
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError) as error:
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise HTTPError(504, timeout_message) from error
        if process.returncode:
            raise HTTPError(failure_status, "Lightcone could not %s:\n%s\n%s", operation, _tail(output), _tail(errors))
        # A report is parsed whole; only failure logs are trimmed.
        output.seek(0)
        return output.read().decode("utf-8", errors="replace")


async def initialize_project(root: Path, project: Path) -> dict:
    """Delegate scaffolding to lc; never invent a project layout here."""
    version_text = await run_cli(
        "--version",
        operation="read the CLI version",
        timeout_message="Lightcone version check timed out.",
        timeout=10,
    )
    try:
        version = Version(version_text.strip().rsplit(" ", 1)[-1])
    except InvalidVersion as error:
        raise HTTPError(503, "Could not identify the Lightcone CLI version.") from error
    if version < Version("0.5.0rc2"):
        raise HTTPError(503, "This setup flow needs lightcone-cli 0.5.0rc2 or newer. Upgrade the CLI used by the Jupyter server.")
    result = await run_cli(
        "init",
        str(project),
        "--json",
        operation="initialize this folder",
        timeout_message="Project initialization timed out. Some files may have been created; retrying lc init is safe.",
    )
    try:
        report = json.loads(result)
    except json.JSONDecodeError as error:
        raise HTTPError(502, "Lightcone returned an unreadable initialization report. Check the project before retrying.") from error
    if not isinstance(report, dict) or not isinstance(report.get("blocked"), list):
        raise HTTPError(502, "Lightcone returned an invalid initialization report.")
    # `converged` describes the state BEFORE init: it is false after a successful
    # creation. A zero exit status and no blocked items indicate successful setup.
    if report["blocked"]:
        raise HTTPError(400, "Project setup needs attention: %s", report["blocked"])
    info = describe_project(root, project)
    if not info["hasSpec"]:
        raise HTTPError(502, "Lightcone finished without creating astra.yaml.")
    return info
