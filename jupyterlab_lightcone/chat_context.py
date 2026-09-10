"""Persisted Lightcone bindings supplied to the agent outside the message body."""

from importlib import import_module
import json
import re

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web


def _binding(value):
    """Validate saved chat metadata before using it as agent context."""
    if (
        not isinstance(value, dict)
        or type(value.get("version")) is not int
        or value["version"] != 1
        or "universeId" not in value
    ):
        raise ValueError("Unsupported Lightcone chat context. Start a new discussion.")
    path = value.get("entrypoint")
    universe = value["universeId"]
    if (
        not isinstance(path, str)
        or "\\" in path
        or re.search(r"[\x00-\x1f\x7f]", path)
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or path.split("/")[-1] != "astra.yaml"
        or (universe is not None and not isinstance(universe, str))
    ):
        raise ValueError("Invalid Lightcone chat context. Start a new discussion.")
    return path, universe


def prompt_context(message, history):
    """Return the conversation's fixed binding to the ACP prompt-context hook.

    No files or active-browser state are consulted. Repeating the binding on
    each submitted message preserves it across reloads and message deletion.
    Conflicting histories fail rather than sending an ambiguously bound prompt.
    """
    binding = None
    for item in (*history, message):
        if item is None or item.deleted:
            continue
        metadata = item.metadata or {}
        if "lightcone" not in metadata:
            continue
        candidate = _binding(metadata["lightcone"])
        if binding is not None and binding != candidate:
            raise ValueError(
                "This chat contains conflicting ASTRA projects or universes. "
                "Start a new discussion."
            )
        binding = candidate
    if binding is None:
        return None
    path, universe = binding
    universe_text = (
        "Use project defaults (no universe override) for decisions and artifacts."
        if universe is None
        else f"Use the bound universe {json.dumps(universe)} for decisions and artifacts."
    )
    return (
        f"ASTRA context: {json.dumps(path)}. {universe_text} "
        "Read astra.yaml and its referenced files directly. "
        "Use lightcone_preview_element for rich chat cards and "
        "lightcone_open_element for tabs."
    )


def context_provider_available():
    """Check optional ACP support and entry-point registration, without patching it."""
    try:
        module = import_module("jupyter_ai_acp_client.prompt_context")
    except ImportError:
        return False
    return (
        getattr(module, "PROMPT_CONTEXT_API_VERSION", None) == 1
        and module.get_prompt_context_providers().get("lightcone") is prompt_context
    )


class ChatContextHandler(APIHandler):
    """Let bound-chat submission verify agent-only context support first."""

    auth_resource = "contents"

    @web.authenticated
    @authorized
    def get(self):
        """Report whether the installed ACP client will consume this binding."""
        try:
            available = context_provider_available()
        except Exception:
            self.log.warning("Could not load agent context providers", exc_info=True)
            available = False
        self.set_header("Cache-Control", "no-store")
        self.finish({"available": available})


def setup_chat_context_handlers(web_app):
    """Register the authenticated compatibility check under the Jupyter base URL."""
    path = url_path_join(
        web_app.settings.get("base_url", "/"),
        "jupyterlab_lightcone",
        "api",
        "chat-context",
    )
    web_app.add_handlers(".*$", [(path, ChatContextHandler)])
