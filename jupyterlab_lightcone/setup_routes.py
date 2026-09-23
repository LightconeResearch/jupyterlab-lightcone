"""What is installed, discovered and configured, for the Customize page.

One read-only route answers every question the Lightcone settings page asks:
which agent adapters and skills are present, which command-line tools the
server can reach, what execution boundary the engine would use, and how the
current project is set up. Every probe degrades to "not found" rather than
failing the request, every subprocess has a timeout, and all of it runs off
the event loop.
"""

import asyncio
from collections.abc import Collection, Mapping, Sequence
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

from jupyter_client.kernelspec import KernelSpecManager, NoSuchKernel
from jupyter_server.auth import authorized
from jupyter_server.utils import ensure_async, url_path_join
from lightcone.engine import container
from lightcone.engine import project as engine_project
from lightcone.engine.sandbox import detect as detect_backend
from tornado import web

from .project_routes import ProjectAPIHandler
from .projects import expose_engine_tools
from .runs import describe_venue

PROBE_TIMEOUT = 10
"""Seconds a version probe may take; a hung tool reports no version, not an error."""

UV_TIMEOUT = 30
"""Seconds uv may take to say whether the lock and the environment are current."""

KERNEL_PROBE_TIMEOUT = 20
"""Seconds the project's interpreter may take to say whether it has ipykernel."""

AGENT_CREDENTIALS = {
    "claude-acp": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
    "codex-acp": ("OPENAI_API_KEY", "CODEX_API_KEY"),
}
"""The environment variables each adapter authenticates with."""

PERSONA_ENTRY_POINTS = "jupyter_ai.personas"
"""The entry point group Jupyter AI loads personas from."""

ANNEX_TIMEOUT = 5
"""Seconds each storage probe (`git config`, then `git annex info`) may take."""

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

MISSING_TOOL = {"found": False, "path": None, "version": None}
"""The row of a tool the server cannot find."""

MARKETPLACE_FOLDER = "marketplaces"
"""Where Claude Code clones plugin marketplaces: sources on offer, never installs."""

_VERSION = re.compile(r"\d+(?:\.\d+)+")
_REMOTE_NAME = re.compile(r"\[([^\]]+)\]\s*$")


def run_command(argv: Sequence[str], cwd: Path | None = None, timeout: float = PROBE_TIMEOUT):
    """Run a tool without a shell; None when it is missing, hangs or cannot start.

    The tool reads end of input rather than the server's terminal, so a
    configured wrapper that asks a question (npx offering to install) cannot
    wait on, or consume, what the user types there.
    """
    try:
        return subprocess.run(
            list(argv),
            cwd=cwd,
            stdin=subprocess.DEVNULL,
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
        return dict(MISSING_TOOL)
    completed = run_command([path, *arguments])
    version = None
    if completed is not None and completed.returncode == 0:
        version = parse_version(completed.stdout) or parse_version(completed.stderr)
    return {"found": True, "path": path, "version": version}


def probe_tools(myst: Sequence[str] = ("myst",)) -> dict:
    """The command-line tools Lightcone relies on, as the server sees them.

    `myst` is the whole MyST command the viewer runs, executable and fixed
    arguments, so a wrapper such as `npx mystmd` reports MyST's own version
    and an empty command reports MyST as missing, as the viewer finds it.
    """
    return {
        "uv": probe_tool("uv", "--version"),
        "git": probe_tool("git", "--version"),
        "git-annex": probe_tool("git-annex", "version", "--raw"),
        "myst": probe_tool(myst[0], *myst[1:], "--version") if myst and myst[0] else dict(MISSING_TOOL),
    }


def module_installed(name: str) -> bool:
    """Whether a Python module can be imported, without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def loaded_personas() -> set[str] | None:
    """The persona entry points Jupyter AI loaded, or None before it loaded any.

    Jupyter AI loads persona classes once, when the first chat opens; an ACP
    persona whose adapter was missing then stays unloaded until the server
    restarts, which is exactly what "discovered" has to reveal.
    """
    try:
        from jupyter_ai_persona_manager.persona_manager import PersonaManager
    except ImportError:
        return set()
    classes = getattr(PersonaManager, "_ep_persona_classes", None)
    if not isinstance(classes, list):
        return None
    return {
        entry["module"]
        for entry in classes
        if isinstance(entry, dict) and isinstance(entry.get("module"), str) and entry.get("persona_class") is not None
    }


def agent_authenticated(identifier: str, home: Path | None, environ: Mapping[str, str], platform: str) -> bool | None:
    """Whether the adapter will find credentials; None when the server cannot tell.

    An API key in the server's environment counts, and so does the file each
    CLI keeps after a login (Claude Code's `.credentials.json`, Codex's
    `auth.json`). Claude Code keeps its login in the Keychain on macOS, which
    a server cannot read, so there a missing file means "unknown".
    """
    if any(environ.get(name) for name in AGENT_CREDENTIALS.get(identifier, ())):
        return True
    if identifier == "claude-acp":
        if home is not None and (home / ".claude" / ".credentials.json").is_file():
            return True
        return None if platform == "darwin" else False
    if identifier == "codex-acp":
        codex_home = Path(environ["CODEX_HOME"]) if environ.get("CODEX_HOME") else (home / ".codex" if home else None)
        return codex_home is not None and (codex_home / "auth.json").is_file()
    return None


def probe_agents(home: Path | None = None, environ: Mapping[str, str] | None = None) -> list[dict]:
    """The ACP personas Lightcone documents, each fact reported on its own.

    ``installed``: Jupyter AI's ACP client is importable; ``executable``: the
    adapter is on the server's PATH; ``discovered``: Jupyter AI loaded the
    persona (None until it loads personas); ``authenticated``: credentials
    were found (None when the server cannot tell).
    """
    installed = module_installed(ACP_CLIENT_MODULE)
    loaded = loaded_personas()
    home = home if home is not None else home_directory()
    environ = os.environ if environ is None else environ
    agents = []
    for identifier, name, executable in AGENT_ADAPTERS:
        path = shutil.which(executable)
        agents.append({
            "id": identifier,
            "name": name,
            "installed": installed,
            "executable": {"name": executable, "found": path is not None, "path": path},
            "discovered": None if loaded is None else identifier in loaded,
            "authenticated": agent_authenticated(identifier, home, environ, sys.platform),
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
    """Order versions numerically where they are numeric, so 0.0.10 follows 0.0.9.

    `isdecimal` accepts exactly the digits `int` parses; `isdigit` would also
    accept superscripts such as "²", which `int` rejects.
    """
    return tuple(
        (0, int(part)) if part.isdecimal() else (1, part)
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


def named_directories(
    root: Path, name: str, depth: int = SKILL_DEPTH, skip: Collection[str] = ()
) -> list[Path]:
    """Directories at most `depth` levels below `root` whose names start with `name`.

    Children of `root` named in `skip` are neither matched nor searched.
    """
    matches = []
    pending = [(root, 0)]
    visited = 0
    while pending and visited < MAX_DIRECTORIES:
        directory, level = pending.pop()
        visited += 1
        for child in subdirectories(directory):
            if level == 0 and child.name in skip:
                continue
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


def install_entries(harness: str, root: Path, name: str) -> list | None:
    """What the harness's own install record lists for a plugin, when it keeps one.

    Claude Code records installed plugins in `installed_plugins.json`, keyed
    `<plugin>@<marketplace>`, each holding a list of installs (a single
    install in older records). Its cache keeps versions that are not, or no
    longer, installed, so a readable record is authoritative: an empty list
    means the plugin is not installed. None means there is no readable
    record, as for Codex, which keeps only an enabled flag in its config.
    """
    if harness != "claude":
        return None
    record = read_json(root / INSTALLED_PLUGINS_FILE)
    plugins = record.get("plugins") if isinstance(record, dict) else None
    if not isinstance(plugins, dict):
        return None
    entries = []
    for key, installs in plugins.items():
        if key.split("@", 1)[0].lower() == name:
            entries.extend(installs if isinstance(installs, list) else [installs])
    return entries


def recorded_plugin(harness: str, entries: list) -> tuple[Path, str | None] | None:
    """The first recorded install whose directory still exists, with its version."""
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
    passed over too. Marketplace clones hold every plugin on offer, installed
    or not, so they are not searched.
    """
    best = None
    for candidate in named_directories(root, name, skip=(MARKETPLACE_FOLDER,)):
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
    """One row per harness and skill: where it is, or where it was looked for.

    A plugin the install record lists is looked for where the record says,
    then in the cache when that directory is gone; one the record leaves out
    is not installed. Without a record the cache decides.
    """
    entries = install_entries(harness, root, name)
    if entries is None:
        found = best_plugin(harness, root, name)
    elif entries:
        found = recorded_plugin(harness, entries) or best_plugin(harness, root, name)
    else:
        found = None
    if found is None:
        return missing_skill(harness, name, str(root))
    path, version = found
    return {"harness": harness, "name": name, "version": version, "path": str(path), "found": True}


def missing_skill(harness: str, name: str, searched: str) -> dict:
    """The row of a skill that is not installed, naming where it was looked for."""
    return {"harness": harness, "name": name, "version": None, "path": searched, "found": False}


def find_skills(home: Path | None) -> list[dict]:
    """Lightcone and ASTRA skills per agent harness, found or not.

    Without a home there is nowhere to look, so every skill is reported
    missing under its conventional `~/.<harness>/plugins` folder and the
    filesystem is not touched.
    """
    return [
        locate_skill(harness, home / f".{harness}" / "plugins", name)
        if home is not None
        else missing_skill(harness, name, f"~/.{harness}/plugins")
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


def uv_check(project: Path, *arguments: str) -> bool | None:
    """uv's own read-only verdict, as `lc status` asks it; None when uv cannot answer."""
    uv = shutil.which("uv")
    if uv is None:
        return None
    completed = run_command([uv, *arguments, "--project", str(project)], cwd=project, timeout=UV_TIMEOUT)
    return None if completed is None else completed.returncode == 0


def project_mode(project: Path) -> str | None:
    """`direct` or `containerized`, as the engine decides; None when it cannot say."""
    try:
        return engine_project.mode(project)
    except Exception:  # A project the engine cannot read reports no mode, never an error page.
        return None


def describe_environment(project: Path) -> dict:
    """Whether the project's uv environment is locked, installed and current.

    ``lockCurrent`` is whether `uv.lock` still agrees with `pyproject.toml`;
    ``venvCurrent`` whether `.venv` still satisfies the lock, asked only in
    direct mode, where recipes run in `.venv`. Either is None when unknown.
    """
    lock = (project / "uv.lock").is_file()
    venv = (project / ".venv").is_dir()
    mode = project_mode(project)
    return {
        "lock": lock,
        "venv": venv,
        "mode": mode,
        "lockCurrent": uv_check(project, "lock", "--check") if lock else None,
        "venvCurrent": uv_check(project, "sync", "--locked", "--exact", "--check") if lock and venv and mode == "direct" else None,
    }


def kernel_name(project: Path) -> str:
    """The kernel spec name registered for a project: `lightcone-<folder>`."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", project.name.lower()).strip("-._") or "project"
    return f"lightcone-{slug}"


def project_python(project: Path) -> Path | None:
    """The interpreter recipes run with, when the host can run it: `.venv` in direct mode."""
    if project_mode(project) != "direct":
        return None
    bin_dir = "Scripts" if os.name == "nt" else "bin"
    python = project / ".venv" / bin_dir / ("python.exe" if os.name == "nt" else "python")
    return python if python.exists() else None


def has_ipykernel(python: Path) -> bool | None:
    """Whether the project's interpreter can import ipykernel; None when it did not answer."""
    completed = run_command(
        [str(python), "-c", "import ipykernel"], cwd=python.parent, timeout=KERNEL_PROBE_TIMEOUT
    )
    return None if completed is None else completed.returncode == 0


def registered_kernel(name: str, python: Path | None) -> bool:
    """Whether a kernel spec of that name starts the project's interpreter."""
    try:
        spec = KernelSpecManager().get_kernel_spec(name)
    except (NoSuchKernel, OSError, ValueError):
        return False
    argv = getattr(spec, "argv", None) or []
    return python is not None and bool(argv) and Path(argv[0]) == python


def describe_kernel(project: Path) -> dict:
    """The project's notebook kernel: its name, interpreter, ipykernel and registration."""
    name = kernel_name(project)
    python = project_python(project)
    return {
        "name": name,
        "python": str(python) if python else None,
        "ipykernel": has_ipykernel(python) if python else None,
        "registered": registered_kernel(name, python),
    }


def register_kernel(project: Path, entrypoint: str) -> dict:
    """Install a user kernel spec that runs notebooks in the project's `.venv`.

    Refuses (409) when the host cannot run the project's interpreter or it
    lacks ipykernel: installing it by hand would not survive the engine's
    exact sync, so the project has to declare it.
    """
    python = project_python(project)
    if python is None:
        raise web.HTTPError(
            409,
            "This project has no .venv the server can run (it may be containerized, "
            "or not installed yet: run lc materialize or uv sync first).",
        )
    if has_ipykernel(python) is not True:
        raise web.HTTPError(
            409,
            "ipykernel is not installed in the project environment. Declare it in the "
            "project (uv add --dev ipykernel), then register the kernel again.",
        )
    name = kernel_name(project)
    spec = {
        "argv": [str(python), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        "display_name": f"Python ({project.name})",
        "language": "python",
        "metadata": {"lightcone": {"project": entrypoint}},
    }
    with tempfile.TemporaryDirectory() as directory:
        (Path(directory) / "kernel.json").write_text(json.dumps(spec, indent=1), encoding="utf-8")
        KernelSpecManager().install_kernel_spec(directory, kernel_name=name, user=True)
    return describe_kernel(project)


def describe_container(project: Path) -> dict:
    """The container runtime this host offers and where the project's image stands.

    ``image`` is the engine's own state: `direct` (no image), `absent`,
    `unfetched` or `present`; None when the engine cannot tell.
    """
    try:
        runtime = container.runtime_hint() or None
    except Exception:  # A host probe that fails means no runtime, never an error page.
        runtime = None
    try:
        image = container.image_state(project)[0]
    except Exception:
        image = None
    return {"runtime": runtime, "image": image}


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


def annex_initialized(project: Path) -> bool:
    """Whether the project's repository has an annex, asked the way the engine asks.

    `annex.uuid` is what `git annex init` writes. It is read before any
    git-annex command runs because git-annex initializes a clone of an annexed
    repository on first use, writing its config, hooks and `.git/annex`.
    """
    completed = run_command(["git", "config", "--get", "annex.uuid"], cwd=project, timeout=ANNEX_TIMEOUT)
    return completed is not None and completed.returncode == 0 and bool(completed.stdout.strip())


def annexed_results(project: Path, *selection: str) -> int | None:
    """How many annexed files under `results/` match a git-annex selection."""
    completed = run_command(
        ["git", "-c", "annex.merge-annex-branches=false", "annex", "find", *selection, "--", "results"],
        cwd=project,
        timeout=ANNEX_TIMEOUT,
    )
    if completed is None or completed.returncode != 0:
        return None
    return len([line for line in completed.stdout.splitlines() if line.strip()])


def describe_content(project: Path) -> dict | None:
    """How many result files are annexed, and how many lack their content here."""
    if not (project / "results").is_dir():
        return {"files": 0, "absent": 0}
    present = annexed_results(project)
    absent = annexed_results(project, "--not", "--in=here")
    if present is None or absent is None:
        return None
    return {"files": present + absent, "absent": absent}


def describe_storage(project: Path) -> dict:
    """git-annex's view of the project: whether it is an annex and which remotes it knows.

    A repository nobody has annexed here is reported as such without asking
    git-annex, so reading the report never initializes an annex. In one that
    is annexed, git-annex would otherwise commit fetched `git-annex` branches
    into the local one, or upgrade the repository, before answering; both are
    turned off, so the answer is what the repository already records.
    """
    if not annex_initialized(project):
        return {"annex": False, "remotes": [], "content": None}
    completed = run_command(
        [
            "git",
            "-c",
            "annex.merge-annex-branches=false",
            "-c",
            "annex.autoupgraderepository=false",
            "annex",
            "info",
            "--fast",
            "--json",
        ],
        cwd=project,
        timeout=ANNEX_TIMEOUT,
    )
    if completed is None or completed.returncode != 0:
        return {"annex": False, "remotes": [], "content": None}
    try:
        info = json.loads(completed.stdout)
    except ValueError:
        return {"annex": False, "remotes": [], "content": None}
    if not isinstance(info, dict) or info.get("success") is not True:
        return {"annex": False, "remotes": [], "content": None}
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
    return {"annex": True, "remotes": remotes, "content": describe_content(project)}


def describe_project_setup(project: Path, entrypoint: str) -> dict:
    """The project-specific part of the report."""
    directory = project_directory(entrypoint)
    return {
        "environment": describe_environment(project),
        "kernel": describe_kernel(project),
        "container": describe_container(project),
        "instructions": describe_instructions(project, directory),
        "storage": describe_storage(project),
    }



def find_home_skills() -> list[dict]:
    """The skills installed in the server user's home."""
    return find_skills(home_directory())


async def build_report(project: Path | None, entrypoint: str = "", myst: Sequence[str] = ("myst",)) -> dict:
    """Gather every probe off the event loop, concurrently.

    Without a project the three project sections are null, so the Customize
    page can still describe the server outside a Lightcone folder.
    """
    expose_engine_tools()
    probes = [
        asyncio.to_thread(module_installed, JUPYTER_AI_MODULE),
        asyncio.to_thread(probe_tools, myst),
        asyncio.to_thread(probe_agents),
        asyncio.to_thread(find_home_skills),
        asyncio.to_thread(detect_sandbox),
        asyncio.to_thread(describe_venue),
    ]
    if project is not None:
        probes.append(asyncio.to_thread(describe_project_setup, project, entrypoint))
    jupyter_ai, tools, agents, skills, sandbox, where, *project_setup = await asyncio.gather(*probes)
    setup = project_setup[0] if project_setup else {
        "environment": None, "kernel": None, "container": None, "instructions": None, "storage": None,
    }
    return {
        "jupyterAi": jupyter_ai,
        "agents": agents,
        "skills": skills,
        "tools": tools,
        "sandbox": sandbox,
        "venue": where,
        **setup,
    }


class SetupHandler(ProjectAPIHandler):
    """Report what is installed, discovered and configured; a missing tool is never an error."""

    unavailable_message = "Setup diagnostics require local files"

    def initialize(self, myst_command: Sequence[str] = ("myst",)):
        """Keep the whole MyST command the viewer runs, fixed arguments included."""
        self.myst = list(myst_command)

    @web.authenticated
    @authorized
    async def get(self):
        """Describe the server, and the project named by `path` when one is given."""
        entrypoint = self.get_query_argument("path", "")
        project = await self.project() if entrypoint else None
        self.set_header("Cache-Control", "no-store")
        self.finish(await build_report(project, entrypoint, self.myst))


class KernelHandler(ProjectAPIHandler):
    """Register the project's environment as a notebook kernel."""

    unavailable_message = "Project kernels require local files"

    @web.authenticated
    @authorized(action="write", resource="contents")
    async def post(self):
        """`{"path": <entrypoint>}` → the kernel as the report describes it.

        Registering writes a kernel spec that runs the project's interpreter,
        so it also needs `execute` on `lightcone`, as project setup does.
        """
        if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, "execute", "lightcone")):
            raise web.HTTPError(403, "Registering a project kernel is not authorized.")
        body = self.get_json_body()
        entrypoint = body.get("path") if isinstance(body, dict) else None
        project = await self.project_named(entrypoint)
        self.finish(await asyncio.to_thread(register_kernel, project, entrypoint))


def setup_setup_handlers(web_app, myst_command: Sequence[str] = ("myst",)):
    """Register `api/setup` and `api/setup/kernel` under the server base URL.

    `myst_command` is the app's `mystra_command` traitlet, so the MyST row
    reports the command the viewer would actually run.
    """
    route = url_path_join(web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "setup")
    web_app.add_handlers(".*$", [
        (route, SetupHandler, {"myst_command": list(myst_command)}),
        (url_path_join(route, "kernel"), KernelHandler),
    ])
