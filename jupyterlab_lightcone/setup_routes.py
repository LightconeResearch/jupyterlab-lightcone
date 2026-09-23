"""What is installed, discovered and configured, for the Customize page.

One read-only route answers every question the Lightcone settings page asks:
which agent adapters and skills are present, which command-line tools the
server can reach, what execution boundary the engine would use, and how the
current project is set up. Every probe degrades to "not found" rather than
failing the request, every subprocess has a timeout, and all of it runs off
the event loop.
"""

import asyncio
from collections.abc import Sequence
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

from jupyter_server.auth import authorized
from jupyter_server.utils import url_path_join
from lightcone.engine.sandbox import detect as detect_backend
from tornado import web

from .project_routes import ProjectAPIHandler
from .projects import expose_engine_tools

PROBE_TIMEOUT = 10
"""Seconds a version probe may take; a hung tool reports no version, not an error."""

ANNEX_TIMEOUT = 5
"""Seconds `git annex info` may take."""

SKILL_DEPTH = 4
"""How many directory levels below a harness's plugins folder skills are looked for."""

MAX_DIRECTORIES = 5000
"""How many directories one skill search may visit, whatever the depth."""

MAX_MANIFEST_BYTES = 262_144
"""Plugin and install manifests larger than this are treated as absent."""

AGENT_ADAPTERS = (
    ("claude-acp", "Claude", "claude-agent-acp"),
    ("codex-acp", "Codex", "codex-acp"),
)
"""Jupyter AI persona entry point, display name and ACP adapter executable."""

ACP_CLIENT_MODULE = "jupyter_ai_acp_client"
JUPYTER_AI_MODULE = "jupyter_ai"

SKILL_HARNESSES = ("claude", "codex")
"""Agent harnesses whose plugin folders (`~/.<harness>/plugins`) hold skills."""

SKILL_NAMES = ("lightcone", "astra")
"""The plugins Lightcone documents; both ship as `<name>/<version>/` in a cache."""

PLUGIN_MANIFESTS = {
    "claude": (".claude-plugin/plugin.json", "plugin.json", ".codex-plugin/plugin.json"),
    "codex": (".codex-plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"),
}
"""Where a plugin directory keeps its manifest, the harness's own form first."""

INSTALLED_PLUGINS_FILE = "installed_plugins.json"
"""Claude Code's record of installed plugins, keyed `<plugin>@<marketplace>`."""

INSTRUCTION_FILES = ("AGENTS.md", "CLAUDE.md")
"""Project instruction files, in the order agents and the Customize page prefer them."""

SPECIAL_ANNEX_REPOSITORIES = {
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
}
"""git-annex's built-in `web` and `bittorrent` special remotes; never user storage."""

ANNEX_TRUST_LEVELS = ("trusted repositories", "semitrusted repositories", "untrusted repositories")

_VERSION = re.compile(r"\d+(?:\.\d+)+")
_REMOTE_NAME = re.compile(r"\[([^\]]+)\]\s*$")


def run_command(argv: Sequence[str], cwd: Path | None = None, timeout: float = PROBE_TIMEOUT):
    """Run a tool without a shell; None when it is missing, hangs or cannot start."""
    try:
        return subprocess.run(
            list(argv),
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def parse_version(text: str | None) -> str | None:
    """The first dotted number in a tool's version banner; None when there is none."""
    match = _VERSION.search(text or "")
    return match.group(0) if match else None


def probe_tool(executable: str, *arguments: str) -> dict:
    """Locate one tool on the server's PATH and ask it for its version."""
    path = shutil.which(executable)
    if path is None:
        return {"found": False, "path": None, "version": None}
    completed = run_command([path, *arguments])
    version = None
    if completed is not None and completed.returncode == 0:
        version = parse_version(completed.stdout) or parse_version(completed.stderr)
    return {"found": True, "path": path, "version": version}


def probe_tools(myst: str = "myst") -> dict:
    """The command-line tools Lightcone relies on, as the server sees them."""
    return {
        "uv": probe_tool("uv", "--version"),
        "git": probe_tool("git", "--version"),
        "git-annex": probe_tool("git-annex", "version", "--raw"),
        "myst": probe_tool(myst, "--version"),
    }


def module_installed(name: str) -> bool:
    """Whether a Python module can be imported, without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def probe_agents() -> list[dict]:
    """The ACP personas Lightcone documents: their Python half and their adapter."""
    installed = module_installed(ACP_CLIENT_MODULE)
    agents = []
    for identifier, name, executable in AGENT_ADAPTERS:
        path = shutil.which(executable)
        agents.append({
            "id": identifier,
            "name": name,
            "installed": installed,
            "executable": {"name": executable, "found": path is not None, "path": path},
        })
    return agents


def read_json(path: Path):
    """Parse a small JSON file; None when it is absent, oversized or malformed."""
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(data) > MAX_MANIFEST_BYTES:
            return None
        return json.loads(data)
    except (OSError, ValueError, UnicodeError):
        return None


def version_key(version: str) -> tuple:
    """Order versions numerically where they are numeric, so 0.0.10 follows 0.0.9."""
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part)
        for part in re.split(r"[.\-+_]", version)
    )


def subdirectories(directory: Path) -> list[Path]:
    """A directory's child directories by name; an unreadable directory has none."""
    try:
        with os.scandir(directory) as entries:
            children = [Path(entry.path) for entry in entries if entry.is_dir()]
    except OSError:
        return []
    return sorted(children, key=lambda child: child.name)


def named_directories(root: Path, name: str, depth: int = SKILL_DEPTH) -> list[Path]:
    """Directories at most `depth` levels below `root` whose names start with `name`."""
    matches = []
    pending = [(root, 0)]
    visited = 0
    while pending and visited < MAX_DIRECTORIES:
        directory, level = pending.pop()
        visited += 1
        for child in subdirectories(directory):
            if child.name.lower().startswith(name):
                matches.append(child)
            if level + 1 < depth:
                pending.append((child, level + 1))
    return sorted(matches)


def plugin_manifest(harness: str, directory: Path) -> dict | None:
    """A plugin directory's manifest, preferring the harness's own form."""
    for relative in PLUGIN_MANIFESTS[harness]:
        manifest = read_json(directory / relative)
        if isinstance(manifest, dict):
            return manifest
    return None


def manifest_version(manifest: dict | None) -> str | None:
    version = manifest.get("version") if manifest else None
    return version if isinstance(version, str) and version else None


def plugin_directories(harness: str, candidate: Path) -> list[Path]:
    """The plugin roots a matching directory stands for: itself, or its version folders."""
    if plugin_manifest(harness, candidate) is not None:
        return [candidate]
    return [child for child in subdirectories(candidate) if plugin_manifest(harness, child) is not None]


def installed_plugin(harness: str, root: Path, name: str) -> tuple[Path, str | None] | None:
    """The plugin the harness's own install record names, when it keeps one.

    Claude Code records installed plugins in `installed_plugins.json`; its
    cache may hold other versions beside the installed one, so the record is
    consulted first. Codex keeps only an enabled flag in its config, so its
    skills are located by walking the cache.
    """
    if harness != "claude":
        return None
    record = read_json(root / INSTALLED_PLUGINS_FILE)
    plugins = record.get("plugins") if isinstance(record, dict) else None
    if not isinstance(plugins, dict):
        return None
    for key, entries in plugins.items():
        if key.split("@", 1)[0].lower() != name or not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("installPath"), str):
                continue
            path = Path(entry["installPath"])
            if not path.is_dir():
                continue
            recorded = entry.get("version")
            version = manifest_version(plugin_manifest(harness, path))
            return path, version or (recorded if isinstance(recorded, str) and recorded else None)
    return None


def best_plugin(harness: str, root: Path, name: str) -> tuple[Path, str | None] | None:
    """The newest plugin directory named for the skill below a harness's plugins folder.

    A directory counts only when a plugin manifest is found in it or in one of
    its version folders, so a marketplace folder that happens to share the
    skill's name prefix is passed over; a manifest naming another plugin is
    passed over too.
    """
    best = None
    for candidate in named_directories(root, name):
        for directory in plugin_directories(harness, candidate):
            manifest = plugin_manifest(harness, directory)
            declared = manifest.get("name")
            if isinstance(declared, str) and declared.lower() != name:
                continue
            version = manifest_version(manifest)
            key = version_key(version or directory.name)
            if best is None or key > best[0]:
                best = (key, directory, version)
    return None if best is None else (best[1], best[2])


def locate_skill(harness: str, root: Path, name: str) -> dict:
    """One row per harness and skill: where it is, or where it was looked for."""
    found = installed_plugin(harness, root, name) or best_plugin(harness, root, name)
    if found is None:
        return {"harness": harness, "name": name, "version": None, "path": str(root), "found": False}
    path, version = found
    return {"harness": harness, "name": name, "version": version, "path": str(path), "found": True}


def find_skills(home: Path | None) -> list[dict]:
    """Lightcone and ASTRA skills per agent harness, found or not."""
    base = home if home is not None else Path("~")
    return [
        locate_skill(harness, base / f".{harness}" / "plugins", name)
        for harness in SKILL_HARNESSES
        for name in SKILL_NAMES
    ]


def home_directory() -> Path | None:
    """The user's home, or None when the server cannot tell."""
    try:
        return Path.home()
    except RuntimeError:
        return None


def detect_sandbox() -> dict:
    """What the engine's exec boundary would enforce on this host."""
    try:
        capability = detect_backend().capability
    except Exception:  # A kernel probe that fails means no boundary, never an error page.
        return {"backend": None, "available": False}
    kind = getattr(capability, "kind", None)
    available = isinstance(kind, str) and kind != "none"
    return {"backend": kind if available else None, "available": available}


def project_directory(entrypoint: str) -> str:
    """The Contents path of the project holding an entrypoint ('' at the root)."""
    parent = PurePosixPath(entrypoint).parent
    return "" if parent == PurePosixPath(".") else parent.as_posix()


def contents_path(directory: str, name: str) -> str:
    return f"{directory}/{name}" if directory else name


def describe_environment(project: Path) -> dict:
    """Whether the project's uv environment is locked and installed."""
    return {"lock": (project / "uv.lock").is_file(), "venv": (project / ".venv").is_dir()}


def describe_instructions(project: Path, directory: str) -> dict:
    """The project's agent instructions: AGENTS.md, else CLAUDE.md, else where AGENTS.md would go."""
    for name in INSTRUCTION_FILES:
        if (project / name).is_file():
            return {"path": contents_path(directory, name), "exists": True}
    return {"path": contents_path(directory, INSTRUCTION_FILES[0]), "exists": False}


def remote_name(description: str) -> str:
    """git-annex describes a configured remote as `<description> [<remote>]`."""
    match = _REMOTE_NAME.search(description)
    return match.group(1) if match else description


def describe_storage(project: Path) -> dict:
    """git-annex's view of the project: whether it is an annex and which remotes it knows."""
    completed = run_command(["git", "annex", "info", "--fast", "--json"], cwd=project, timeout=ANNEX_TIMEOUT)
    if completed is None or completed.returncode != 0:
        return {"annex": False, "remotes": []}
    try:
        info = json.loads(completed.stdout)
    except ValueError:
        return {"annex": False, "remotes": []}
    if not isinstance(info, dict) or info.get("success") is not True:
        return {"annex": False, "remotes": []}
    remotes = []
    for level in ANNEX_TRUST_LEVELS:
        repositories = info.get(level)
        for repository in repositories if isinstance(repositories, list) else []:
            if (
                not isinstance(repository, dict)
                or repository.get("here")
                or repository.get("uuid") in SPECIAL_ANNEX_REPOSITORIES
                or not isinstance(repository.get("description"), str)
            ):
                continue
            remotes.append(remote_name(repository["description"]))
    return {"annex": True, "remotes": remotes}


def describe_project_setup(project: Path, entrypoint: str) -> dict:
    """The project-specific part of the report."""
    directory = project_directory(entrypoint)
    return {
        "environment": describe_environment(project),
        "instructions": describe_instructions(project, directory),
        "storage": describe_storage(project),
    }


async def build_report(project: Path | None, entrypoint: str = "", myst: str = "myst") -> dict:
    """Gather every probe off the event loop, concurrently.

    Without a project the three project sections are null, so the Customize
    page can still describe the server outside a Lightcone folder.
    """
    expose_engine_tools()
    probes = [
        asyncio.to_thread(probe_tools, myst),
        asyncio.to_thread(probe_agents),
        asyncio.to_thread(find_skills, home_directory()),
        asyncio.to_thread(detect_sandbox),
    ]
    if project is not None:
        probes.append(asyncio.to_thread(describe_project_setup, project, entrypoint))
    tools, agents, skills, sandbox, *project_setup = await asyncio.gather(*probes)
    setup = project_setup[0] if project_setup else {"environment": None, "instructions": None, "storage": None}
    return {
        "jupyterAi": module_installed(JUPYTER_AI_MODULE),
        "agents": agents,
        "skills": skills,
        "tools": tools,
        "sandbox": sandbox,
        **setup,
    }


class SetupHandler(ProjectAPIHandler):
    """Report what is installed, discovered and configured; a missing tool is never an error."""

    unavailable_message = "Setup diagnostics require local files"

    def initialize(self, myst_command: Sequence[str] = ("myst",)):
        self.myst = myst_command[0] if myst_command else "myst"

    @web.authenticated
    @authorized
    async def get(self):
        """Describe the server, and the project named by `path` when one is given."""
        entrypoint = self.get_query_argument("path", "")
        project = await self.project() if entrypoint else None
        self.set_header("Cache-Control", "no-store")
        self.finish(await build_report(project, entrypoint, self.myst))


def setup_setup_handlers(web_app, myst_command: Sequence[str] = ("myst",)):
    """Register `api/setup` under the server base URL, including JupyterHub prefixes.

    `myst_command` is the app's `mystra_command` traitlet, so the MyST row
    reports the executable the viewer would actually run.
    """
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "setup")
    web_app.add_handlers(".*$", [(route, SetupHandler, {"myst_command": list(myst_command)})])
