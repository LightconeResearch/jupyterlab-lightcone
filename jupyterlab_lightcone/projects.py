"""Open or initialize a local Lightcone project through its existing CLI."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import tempfile

from packaging.version import InvalidVersion, Version
from tornado.web import HTTPError


def project_path(root: Path, value: str) -> Path:
    """Resolve an entered directory within the server's filesystem boundary."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise HTTPError(400, "Enter a project folder.")
    root = root.resolve()
    try:
        candidate = Path(value.strip()).expanduser()
    except RuntimeError as error:
        raise HTTPError(400, "Could not resolve that home directory. Enter a valid project folder.") from error
    if ":" in value:
        raise HTTPError(400, "Project setup supports the local Jupyter drive only.")
    if ".." in candidate.parts:
        raise HTTPError(400, "Parent-directory traversal is not supported.")
    candidate = (root / candidate).resolve()
    if not candidate.is_relative_to(root):
        raise HTTPError(400, "Choose a folder inside this Jupyter server's root directory.")
    if candidate.exists() and not candidate.is_dir():
        raise HTTPError(400, "The project path is a file. Choose a folder.")
    # A spec symlink must not let a project escape the server root either.
    if not (candidate / "astra.yaml").resolve().is_relative_to(root):
        raise HTTPError(400, "The project specification points outside the server root.")
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


async def run_cli(*args: str, timeout: float = 180) -> str:
    """Run a fixed CLI invocation without a shell; bound time and returned logs."""
    executable = shutil.which("lc")
    if not executable:
        raise HTTPError(503, "Lightcone CLI is unavailable in the Jupyter server environment. Install a supported lightcone-cli release before creating a project.")
    # A file avoids accumulating unbounded dependency-install output in memory.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = await asyncio.create_subprocess_exec(
            executable, *args, stdout=output, stderr=errors,
            start_new_session=True,
        )
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
            message = (
                "Lightcone version check timed out."
                if args == ("--version",)
                else "Project initialization timed out. Some files may have been created; retrying lc init is safe."
            )
            raise HTTPError(504, message) from error
        output.seek(0, os.SEEK_END)
        output.seek(max(0, output.tell() - 32768))
        text = output.read().decode("utf-8", errors="replace")
        errors.seek(0, os.SEEK_END)
        errors.seek(max(0, errors.tell() - 32768))
        error_text = errors.read().decode("utf-8", errors="replace")
    if process.returncode:
        operation = "read the CLI version" if args == ("--version",) else "initialize this folder"
        raise HTTPError(400, "Lightcone could not %s:\n%s\n%s", operation, text, error_text)
    return text


async def initialize_project(root: Path, project: Path) -> dict:
    """Delegate scaffolding to lc; never invent a project layout here."""
    version_text = await run_cli("--version", timeout=10)
    try:
        version = Version(version_text.strip().rsplit(" ", 1)[-1])
    except InvalidVersion as error:
        raise HTTPError(503, "Could not identify the Lightcone CLI version.") from error
    if version < Version("0.5.0rc2"):
        raise HTTPError(503, "This setup flow needs lightcone-cli 0.5.0rc2 or newer. Upgrade the CLI used by the Jupyter server.")
    result = await run_cli("init", str(project), "--json")
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
