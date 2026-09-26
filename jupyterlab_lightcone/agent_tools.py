"""MCP tools for the originating JupyterLab browser.

Registered through the `jupyter_server_mcp.tools` entry point, so they run
inside Jupyter AI's built-in MCP server, where the request headers name the
calling chat and persona. They address the project of that chat and act only
in the browser whose message the persona is answering; nothing is broadcast.
"""

from pathlib import Path
import re

from fastmcp.server.dependencies import get_http_headers
from jupyter_server.serverapp import ServerApp
from jupyter_server_mcp.client_routing import CHAT_ID_HEADER, PERSONA_ID_HEADER, WEB_CLIENT_ID_METADATA_KEY
from jupyterlab_chat.models import MimeModel, NewMessage
from jupyterlab_commands_toolkit.tools import execute_command, target_client_id

from .projects import CURRENT_PROJECT, join_project, project_entrypoint
from .versions import COMMIT_NAME

TOOLS = [
    "jupyterlab_lightcone.agent_tools:lightcone_preview_element",
    "jupyterlab_lightcone.agent_tools:lightcone_open_element",
]

ASTRA_MIME_TYPE = "application/vnd.lightcone.astra+json"
"""The MIME type of a preview card, rendered by the frontend's ASTRA MIME renderer."""

PROMPT_METADATA_KEY = "lightcone_prompt"
"""The MIME metadata entry naming the prompt a card was made for, so retries reuse it."""

_KEY_LIMIT = 256


def _settings() -> dict:
    """The running server's web application settings."""
    return ServerApp.instance().web_app.settings


def _origin_manager():
    """The calling chat's persona manager, from the header Jupyter AI adds to every tool call.

    The registry is the one jupyter-server-mcp's own routing middleware reads
    (`ClientRoutingMiddleware`); the middleware exposes only the resolved
    browser, not the persona, so the walk is repeated here.
    """
    managers = _settings().get("jupyter-ai", {}).get("persona-managers", {})
    return managers.get(get_http_headers().get(CHAT_ID_HEADER))


def _origin_entrypoint() -> str | None:
    """Contents path of the astra.yaml of the project the calling chat belongs to."""
    manager = _origin_manager()
    if manager is None:
        return None
    project = join_project(manager, _settings().get(CURRENT_PROJECT))
    if project is None:
        return None
    return project_entrypoint(Path(manager.root_dir), project)


async def _command(name: str, args: dict) -> dict:
    """Run a workbench command in the originating browser; never broadcast."""
    if not target_client_id.get():
        return {
            "success": False,
            "error": ("NO_ACTIVE_CLIENT: Send a message from Jupyter AI in the browser first."),
        }
    entrypoint = _origin_entrypoint()
    if entrypoint is None:
        return {
            "success": False,
            "error": (
                "NO_PROJECT: This chat belongs to no ASTRA project. Ask the "
                "user to open a project folder in the file browser, then start "
                "a new chat."
            ),
        }
    result = await execute_command(f"jupyterlab_lightcone:{name}", {**args, "entrypoint": entrypoint})
    if not result.get("success") and "timed out" in str(result.get("error", "")).lower():
        return {
            **result,
            "status": "unconfirmed",
            "retry": "Retrying is safe; repeated opens and previews are reused.",
        }
    return result


async def lightcone_open_element(target: str) -> dict:
    """Open an ASTRA element as a tab in the browser that sent this prompt.

    target is an element path rooted at the astra.yaml of the project you are
    working in, e.g. decisions.covariance_source or clustering.outputs.xi.
    Read astra.yaml directly to find real targets. Opens reuse the unpinned
    ASTRA preview in this project. User-pinned tabs are retained; opening an
    already visible record focuses its tab. Pinning is controlled by the user.
    This does not execute recipes or download missing papers. A timeout is
    unconfirmed: the tab may have opened, and retrying is safe.
    """
    return await _command("open-element", {"target": target})


def _card_version(value) -> dict | None:
    """The committed output version the browser pinned for a card, when well formed.

    The browser names the newest commit of an output's file (and its git-annex
    key); anything malformed pins nothing, so the card follows current data.
    """
    if not isinstance(value, dict):
        return None
    commit = value.get("commit")
    if not isinstance(commit, str) or not COMMIT_NAME.fullmatch(commit.lower()):
        return None
    version = {"commit": commit.lower()}
    key = value.get("key")
    if isinstance(key, str) and 0 < len(key) <= _KEY_LIMIT and not re.search(r"[\s/\\]", key):
        version["key"] = key
    return version


def _origin_persona():
    """The calling persona, provided it is answering the browser this call targets.

    Repeats jupyter-server-mcp's `ClientRoutingMiddleware` walk from the
    persona to the message it is processing, because the middleware publishes
    only the browser id. The message is published through the persona's own
    chat model so that it is attributed to the agent, not to the human.
    """
    manager = _origin_manager()
    persona = manager.personas.get(get_http_headers().get(PERSONA_ID_HEADER)) if manager else None
    message = getattr(persona, "processing_message", None)
    client = target_client_id.get()
    if not client or message is None or (message.metadata or {}).get(WEB_CLIENT_ID_METADATA_KEY) != client:
        return None
    return persona


def _existing_card(persona, prompt_id: str, payload: dict) -> str | None:
    """The id of a card this persona already published for this prompt and payload."""
    for message in persona.chat.get_messages():
        mime = message.mime_model
        # Jupyter Chat rebuilds a persisted Message with Message(**dict), which
        # leaves the nested MIME model a plain dict (jupyterlab_chat.models has
        # no __post_init__ hydrating it).
        if isinstance(mime, dict):
            mime = MimeModel(**mime)
        if (
            not message.deleted
            and message.sender == persona.id
            and mime is not None
            and (mime.metadata or {}).get(PROMPT_METADATA_KEY) == prompt_id
            and mime.data.get(ASTRA_MIME_TYPE) == payload
        ):
            return message.id
    return None


async def lightcone_preview_element(target: str) -> dict:
    """Display an ASTRA preview card directly in the originating chat.

    This is the default way to show figures, decisions, inputs, findings,
    prior insights or analyses. Read astra.yaml directly to find real targets.
    target is an element path rooted at the astra.yaml of the project you are
    working in, e.g. outputs.fit or clustering.decisions.method.
    Clicking the card opens its tab; use lightcone_open_element when a
    separate tab is explicitly wanted. Do not emit JSON or MySTRA roles in
    prose to create cards. No recipes execute and no papers are downloaded.
    Repeated previews of the same target in one prompt reuse the card.
    An output's card keeps showing the version committed when it was made.
    """
    result = await _command("resolve-preview", {"target": target})
    if not result.get("success"):
        return result
    element = result.get("result")
    if (
        not isinstance(element, dict)
        or any(not isinstance(element.get(key), str) or not element[key] for key in ("entrypoint", "target", "label"))
        or "universeId" not in element
        or (element["universeId"] is not None and not isinstance(element["universeId"], str))
    ):
        return {
            "success": False,
            "error": "INVALID_PREVIEW_RESPONSE: The browser returned an incomplete ASTRA reference.",
        }
    persona = _origin_persona()
    if persona is None:
        return {"success": False, "error": "NO_ACTIVE_PERSONA: Send a prompt from Jupyter AI first."}
    payload = {
        "version": 1,
        "entrypoint": element["entrypoint"],
        "target": element["target"],
        "universeId": element["universeId"],
    }
    output_version = _card_version(element.get("outputVersion"))
    if output_version is not None:
        payload["outputVersion"] = output_version
    prompt_id = persona.processing_message.id
    existing = _existing_card(persona, prompt_id, payload)
    if existing is not None:
        return {"success": True, "message_id": existing, "reused": True}
    fallback = f"ASTRA: {element['label']} ({target}) — {element['entrypoint']} · {element['universeId'] or 'defaults'}"
    message_id = persona.chat.add_message(
        NewMessage(
            body=fallback,
            sender=persona.id,
            mime_model=MimeModel(data={ASTRA_MIME_TYPE: payload, "text/plain": fallback}, metadata={PROMPT_METADATA_KEY: prompt_id}),
        )
    )
    return {"success": True, "message_id": message_id, "reused": False}
