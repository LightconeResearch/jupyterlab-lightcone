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


LIGHTCONE_DIRECTORY = ".lightcone"
"""The ignored project folder holding the workbench's stores."""

def inside_root(root: Path, candidate: Path, message: str) -> Path:
    """Resolve symlinks first, then refuse anything outside `root`."""
    root = root.resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root):
        raise HTTPError(403, message)
    return resolved


def entrypoint_path(value) -> PurePosixPath | None:
    """The Contents path an entrypoint names, or None unless it is a local `astra.yaml`.

    The one rule for entrypoints the browser reports and chats record: a
    string, relative, on the local drive (no drive prefix, no backslash),
    without parent segments, naming `astra.yaml`. A NUL is refused here since
    tornado strips it from query arguments only, and `Path.resolve` rejects it.
    """
    if not isinstance(value, str) or not value or value.startswith("/"):
        return None
    if any(character in value for character in "\\:\x00"):
        return None
    path = PurePosixPath(value)
    if ".." in path.parts or path.name != "astra.yaml":
        return None
    return path


def project_root(root: Path, path: str) -> Path:
    """Resolve only a local ASTRA entrypoint within the contents root, or raise a 400/403."""
    entrypoint = entrypoint_path(path)
    if entrypoint is None:
        raise HTTPError(400, "A local astra.yaml path is required")
    return inside_root(root, Path(entrypoint), "Project is outside the contents root").parent


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


def project_directory(entrypoint: str) -> str:
    """The Contents path of the project folder an entrypoint names; the root is ``''``.

    Taken from the entrypoint as the browser wrote it, not from a resolved
    folder: a project reached through a symlink keeps the paths under which the
    browser opens its files.
    """
    parent = PurePosixPath(entrypoint).parent.as_posix()
    return "" if parent == "." else parent


def spec_project(root: Path, entrypoint) -> Path | None:
    """The project whose `astra.yaml` has this Contents path, if it is a file.

    Validates as `project_root` does, answering None instead of an error.
    Paths stay logical, as in `owning_project`.
    """
    path = entrypoint_path(entrypoint)
    if path is None:
        return None
    spec = root / path
    return spec.parent if spec.is_file() else None


def chat_project(manager) -> Path | None:
    """The project a Jupyter AI persona manager's chat belongs to, without side effects.

    In order: the project storing the chat file, so chats may live in
    `chats/`; else the project recorded in the chat when it was first opened,
    if that specification still exists; else None. Only upstream's manager
    and chat APIs are used, so it holds for any manager class. The
    `chat-project` route applies the same order to the saved file.
    """
    root = Path(manager.root_dir)
    chat = Path(manager.get_chat_path(relative=True))
    project = owning_project(root, chat.parent)
    if project is not None:
        return project
    return spec_project(root, manager.chat.get_metadata().get(CHAT_PROJECT))


def join_project(manager, current: str | None) -> Path | None:
    """The chat's project, joining `current`, the workbench's current project, without one.

    The one rule behind both the agent's working directory and the project its
    presentation tools address: `chat_project`, then `current`, which is then
    recorded in the chat so the conversation keeps its project when the user
    moves to another. Jupyter AI asks for the directory while it opens the
    chat, before any message, so the record is made on first opening. A
    recorded project that no longer exists is replaced the same way. This is
    the only function that writes to the chat document.
    """
    project = chat_project(manager)
    if project is None:
        root = Path(manager.root_dir)
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
    """Let the in-process engine find the git-annex wheel installed beside it.

    `lightcone.engine.project.converge` looks git-annex up on PATH, which
    lacks this environment's scripts when the server was started without
    activating it. Appending keeps any tool the user already has ahead of the
    bundled one. The extension's own annex reads resolve the executable
    themselves; only the engine needs the PATH.
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
