"""Locate local Lightcone projects and set them up with the Lightcone engine."""

import asyncio
import os
from pathlib import Path, PurePosixPath
import sysconfig

from lightcone.engine.project import ProjectError, converge
from tornado.web import HTTPError


CURRENT_PROJECT = "jupyterlab_lightcone.current_project"
"""The web application setting holding the entrypoint the browser reported as current."""

CHAT_PROJECT = "lightcone_project"
"""The chat metadata entry recording the project a chat joined when first opened."""


def inside_root(root: Path, candidate: Path, message: str) -> Path:
    """Resolve symlinks first, then refuse anything outside `root`."""
    root = root.resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root):
        raise HTTPError(403, message)
    return resolved


def project_root(root: Path, path: str) -> Path:
    """Resolve only a local ASTRA entrypoint within the contents root.

    Refuses what `spec_project` refuses before touching the filesystem: an
    entrypoint read from a JSON body may hold a NUL, which tornado strips
    from query arguments only and `Path.resolve` rejects with a ValueError.
    """
    if not path or path.startswith("/") or any(character in path for character in "\\:\x00"):
        raise HTTPError(400, "A local astra.yaml path is required")
    if ".." in path.split("/") or Path(path).name != "astra.yaml":
        raise HTTPError(400, "A local astra.yaml path is required")
    return inside_root(root, Path(path), "Project is outside the contents root").parent


def owning_project(root: Path, directory: Path) -> Path | None:
    """Find the nearest ASTRA project at or above `directory`, never leaving `root`.

    The server-side counterpart of the frontend's `findProjectRoot`, so a chat
    kept in a project subfolder such as `chats/` still belongs to that project.

    Paths stay logical, exactly as the Contents API presents them, so a project
    reached through a symlink out of the server root (a common JupyterHub home)
    resolves the same way here as in the browser. `inside_root` still resolves
    for the routes that must not be escaped; this walk only reads directories
    Jupyter already serves. A non-file `astra.yaml` is skipped rather than an
    error, unlike the frontend: an agent session must still get a directory.
    """
    if ".." in directory.parts:
        return None
    current = root / directory
    while True:
        if (current / "astra.yaml").is_file():
            return current
        if current == root or root not in current.parents:
            return None
        current = current.parent


def project_entrypoint(root: Path, project: Path) -> str:
    """The Jupyter Contents path of a project's specification."""
    relative = project.relative_to(root).as_posix()
    return "astra.yaml" if relative == "." else f"{relative}/astra.yaml"


def spec_project(root: Path, entrypoint) -> Path | None:
    """The project whose `astra.yaml` has this Contents path, if it is a file.

    Validates the entrypoints the browser reports and chats record: relative,
    on the local drive, without parent traversal, and still present. Paths
    stay logical, as in `owning_project`.
    """
    if (
        not isinstance(entrypoint, str)
        or entrypoint.startswith("/")
        or any(character in entrypoint for character in "\\:\x00")
    ):
        return None
    path = PurePosixPath(entrypoint)
    if ".." in path.parts or path.name != "astra.yaml":
        return None
    spec = root / path
    return spec.parent if spec.is_file() else None


def chat_project(manager, current: str | None = None) -> Path | None:
    """The project a Jupyter AI persona manager's chat belongs to.

    The one rule behind both the agent's working directory and the project its
    presentation tools address, in order:

    1. the project storing the chat file, so chats may live in `chats/`;
    2. the project recorded in the chat when it was first opened;
    3. `current`, the workbench's current project, which is then recorded so
       the conversation keeps its project when the user moves to another.
       Jupyter AI asks for the directory while it opens the chat, before any
       message, so this happens on first opening, not first use.

    A recorded project that no longer exists is replaced the same way. Only
    upstream's manager and chat APIs are used, so it holds for any manager class.
    """
    root = Path(manager.root_dir)
    chat = Path(manager.get_chat_path(relative=True))
    project = owning_project(root, chat.parent)
    if project is not None:
        return project
    project = spec_project(root, manager.chat.get_metadata().get(CHAT_PROJECT))
    if project is None:
        project = spec_project(root, current)
        if project is not None:
            manager.chat.set_metadata(CHAT_PROJECT, project_entrypoint(root, project))
    return project


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
        "entrypoint": project_entrypoint(root.resolve(), project),
        "hasSpec": spec.is_file(),
    }


def expose_engine_tools() -> None:
    """Let the engine find the git-annex installed beside it.

    The engine looks its tools up on PATH, which lacks this environment's
    scripts when the server was started without activating it. Appending
    keeps any tool the user already has ahead of the bundled one.
    """
    scripts = sysconfig.get_path("scripts")
    paths = os.environ.get("PATH", "").split(os.pathsep)
    if scripts not in paths:
        os.environ["PATH"] = os.pathsep.join([*paths, scripts])


async def initialize_project(root: Path, project: Path) -> dict:
    """Delegate scaffolding to the engine; never invent a project layout here."""
    try:
        # Convergence installs the environment, so it runs off the event loop.
        report = await asyncio.to_thread(converge, project)
    except ProjectError as error:
        # The client is sent log_message unformatted, so it carries no arguments.
        raise HTTPError(400, f"Lightcone could not initialize this folder:\n{error}") from error
    if report.blocked:
        # The engine names what is blocked; its warnings say what to do about it.
        details = "\n".join(["; ".join(report.blocked), *report.warnings])
        raise HTTPError(400, f"Project setup needs attention: {details}")
    info = describe_project(root, project)
    if not info["hasSpec"]:
        raise HTTPError(502, "Lightcone finished without creating astra.yaml.")
    return info
