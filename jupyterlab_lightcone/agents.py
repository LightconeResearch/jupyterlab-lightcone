"""Which coding agents Jupyter AI can offer on this server.

Jupyter AI drives Claude Code, Codex and OpenCode through the Agent Client
Protocol (ACP). Each of its ACP personas looks for an adapter executable when
it loads and is left out, with only a server log warning, when the adapter is
missing. The tour asks this module which adapters are present so it can tell
the user what to install instead of showing an empty persona menu.
"""

import shutil
from dataclasses import asdict, dataclass
from importlib.metadata import entry_points

PERSONA_GROUP = "jupyter_ai.personas"


@dataclass(frozen=True)
class AgentAdapter:
    """An ACP agent as jupyter-ai-acp-client offers it, with its own install steps."""

    id: str
    name: str
    persona: str
    executable: str
    install: str
    login: str
    docs: str


# The executables and entry point names mirror jupyter-ai-acp-client 0.3, which
# jupyter-ai 3.2 pins; revisit them together with the jupyter-ai dependency.
AGENTS = (
    AgentAdapter(
        id="claude",
        name="Claude Code",
        persona="claude-acp",
        executable="claude-agent-acp",
        install="npm install -g @agentclientprotocol/claude-agent-acp",
        login="claude",
        docs="https://github.com/agentclientprotocol/claude-agent-acp",
    ),
    AgentAdapter(
        id="codex",
        name="Codex",
        persona="codex-acp",
        executable="codex-acp",
        install="npm install -g @agentclientprotocol/codex-acp",
        login="codex login",
        docs="https://github.com/agentclientprotocol/codex-acp",
    ),
    AgentAdapter(
        id="opencode",
        name="OpenCode",
        persona="opencode-acp",
        executable="opencode",
        install="npm install -g opencode-ai",
        login="opencode auth login",
        docs="https://opencode.ai/docs/",
    ),
)


def agent_readiness(which=None, personas=None) -> dict:
    """Report each agent's adapter on this server's PATH and whether Jupyter AI offers it.

    `which` and `personas` exist for tests; by default the real PATH and the
    persona entry points of the running environment are consulted. Nothing is
    installed or executed: adapters are only looked up.
    """
    which = which or shutil.which
    if personas is None:
        personas = {point.name for point in entry_points(group=PERSONA_GROUP)}
    return {
        "npm": which("npm") is not None,
        "agents": [
            {
                **asdict(agent),
                "installed": which(agent.executable) is not None,
                "offered": agent.persona in personas,
            }
            for agent in AGENTS
        ],
    }
