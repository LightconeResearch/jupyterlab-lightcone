"""MCP tools for the originating JupyterLab browser, and when agents should use them.

Imports are lazy so the inventory works even where Jupyter AI was removed.
"""

import re

from .versions import COMMIT_NAME

ASTRA_MIME_TYPE = "application/vnd.lightcone.astra+json"
PROMPT_METADATA_KEY = "lightcone_prompt"
_KEY_LIMIT = 256

TOOLS = [
    "jupyterlab_lightcone.agent_tools:lightcone_preview_element",
    "jupyterlab_lightcone.agent_tools:lightcone_open_element",
]

SERVER_INSTRUCTIONS = """\
Lightcone workbench: you are answering in a JupyterLab chat beside the user's \
ASTRA project, and the user sees what the lightcone_* tools display.
- When the user asks to see, show or plot something in the project, or when \
showing an element answers better than describing it (a figure or table above \
all), call lightcone_preview_element with its element path, e.g. outputs.fit. \
It shows the element as a card in this chat: outputs (figures, plots, tables, \
results), decisions, inputs, findings, prior insights or analyses. Prefer a \
card to a file path or a description of an image.
- For a figure named by number or caption, first find the matching output in \
astra.yaml.
- Call lightcone_open_element only when the user wants an element in its own tab."""


def add_server_instructions(serverapp) -> bool:
    """Tell agents when to use these tools, through Jupyter's MCP server.

    Agents that load MCP tools on demand, as Claude Code does beside many
    other servers, list only the tools' names until they search for one, so
    the descriptions below go unread when an agent chooses how to answer.
    Server instructions are shown to them up front instead. jupyter-server-mcp
    offers no setting for them, so they are appended to its running FastMCP
    server, keeping any instructions another package set. That server exists
    once the MCP extension has started; Jupyter AI connects agents later, when
    a chat opens. Returns whether a server received the instructions.
    """
    apps = serverapp.extension_manager.extension_apps.get("jupyter_server_mcp", ())
    added = False
    for app in apps:
        mcp = getattr(getattr(app, "mcp_server_instance", None), "mcp", None)
        if mcp is None:
            continue
        current = mcp.instructions or ""
        if SERVER_INSTRUCTIONS not in current:
            mcp.instructions = (
                f"{current}\n\n{SERVER_INSTRUCTIONS}" if current else SERVER_INSTRUCTIONS
            )
        added = True
    return added


def _settings() -> dict:
    """The running server's web application settings."""
    from jupyter_server.serverapp import ServerApp

    return ServerApp.instance().web_app.settings


def _origin_manager():
    """Find the calling chat's persona manager from Jupyter AI's MCP headers."""
    from fastmcp.server.dependencies import get_http_headers

    from jupyter_server_mcp.client_routing import CHAT_ID_HEADER

    managers = _settings().get("jupyter-ai", {}).get("persona-managers", {})
    return managers.get(get_http_headers().get(CHAT_ID_HEADER))


def _origin_entrypoint() -> str | None:
    """Contents path of the astra.yaml of the project the calling chat belongs to."""
    from pathlib import Path

    from .projects import CURRENT_PROJECT, join_project, project_entrypoint

    manager = _origin_manager()
    if manager is None:
        return None
    project = join_project(manager, _settings().get(CURRENT_PROJECT))
    if project is None:
        return None
    return project_entrypoint(Path(manager.root_dir), project)


async def _command(name: str, args: dict) -> dict:
    """Require upstream's per-call browser routing; never broadcast."""
    from jupyterlab_commands_toolkit.tools import execute_command, target_client_id

    if not target_client_id.get():
        return {
            "success": False,
            "error": (
                "NO_ACTIVE_CLIENT: Send a message from Jupyter AI "
                "in the browser first."
            ),
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
    result = await execute_command(
        f"jupyterlab_lightcone:{name}", {**args, "entrypoint": entrypoint}
    )
    if not result.get("success") and "timed out" in str(result.get("error", "")).lower():
        return {
            **result,
            "status": "unconfirmed",
            "retry": "Retrying is safe; repeated opens and previews are reused.",
        }
    return result


async def lightcone_open_element(target: str) -> dict:
    """Open an astra.yaml element in its own JupyterLab tab, beside this chat.

    Use it only when the user asks for a tab, or to open an element or keep
    it open; to show an element in the conversation, use
    lightcone_preview_element. The tab opens in the browser that sent this
    prompt. target is an element path rooted at the astra.yaml of the
    project you are working in, e.g. decisions.covariance_source or
    clustering.outputs.xi.
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
    """Resolve the calling persona using the same registry as MCP routing.

    This small compatibility adapter targets Jupyter AI 3.2. Frontend
    sendMessage attributes messages to the human, so publish through the
    persona's chat model instead.
    """
    from fastmcp.server.dependencies import get_http_headers
    from jupyterlab_commands_toolkit.tools import target_client_id

    from jupyter_server_mcp.client_routing import (
        CHAT_ID_HEADER, PERSONA_ID_HEADER, WEB_CLIENT_ID_METADATA_KEY,
    )

    headers = get_http_headers()
    manager = _origin_manager()
    persona = (
        manager.personas.get(headers.get(PERSONA_ID_HEADER))
        if manager else None
    )
    message = getattr(persona, "processing_message", None)
    client = target_client_id.get()
    if (
        not client
        or message is None
        or (message.metadata or {}).get(WEB_CLIENT_ID_METADATA_KEY) != client
        or persona.chat.get_id() != headers.get(CHAT_ID_HEADER)
    ):
        return None
    return persona


async def lightcone_preview_element(target: str) -> dict:
    """Show a figure, plot, table or other astra.yaml element as a card in this chat.

    Use it when the user asks to see, show, display or plot something in the
    project, or when showing an element answers better than describing it.
    This is the default way to show outputs (figures, tables, results),
    decisions, inputs, findings, prior insights or analyses; prefer it to a
    file path or a description of an image. Read astra.yaml directly to find
    real targets, including for a figure named by number or caption.
    target is an element path rooted at the astra.yaml of the project you are
    working in, e.g. outputs.fit or clustering.decisions.method.
    Clicking the card opens its tab; use lightcone_open_element when a
    separate tab is explicitly wanted. Do not emit JSON or MySTRA roles in
    prose to create cards. No recipes execute and no papers are downloaded.
    Repeated previews of the same target in one prompt reuse the card.
    Output cards retain the committed snapshot the browser resolved.
    """
    result = await _command("resolve-preview", {"target": target})
    if not result.get("success"):
        return result
    element = result.get("result")
    if (
        not isinstance(element, dict)
        or any(
            not isinstance(element.get(key), str) or not element[key]
            for key in ("entrypoint", "target", "label")
        )
        or "universeId" not in element
        or (
            element["universeId"] is not None
            and not isinstance(element["universeId"], str)
        )
    ):
        return {
            "success": False,
            "error": "INVALID_PREVIEW_RESPONSE: The browser returned an incomplete ASTRA reference.",
        }
    persona = _origin_persona()
    if persona is None:
        return {
            "success": False,
            "error": "NO_ACTIVE_PERSONA: Send a prompt from Jupyter AI first.",
        }

    from jupyterlab_chat.models import MimeModel, NewMessage

    payload = {
        "version": 1,
        "entrypoint": element["entrypoint"],
        "target": element["target"],
        "universeId": element["universeId"],
    }
    output_version = _card_version(element.get("outputVersion"))
    if output_version is not None:
        payload["outputVersion"] = output_version
    mime_type = ASTRA_MIME_TYPE
    prompt_id = persona.processing_message.id
    for message in persona.chat.get_messages():
        mime = message.mime_model
        # Chat's persisted models currently deserialize nested MIME models as dicts.
        if isinstance(mime, dict):
            mime = MimeModel(**mime)
        if (
            not message.deleted
            and message.sender == persona.id
            and mime is not None
            and (mime.metadata or {}).get(PROMPT_METADATA_KEY) == prompt_id
            and mime.data.get(mime_type) == payload
        ):
            return {"success": True, "message_id": message.id, "reused": True}
    fallback = (
        f"ASTRA: {element['label']} ({target}) — "
        f"{element['entrypoint']} · {element['universeId'] or 'defaults'}"
    )
    message_id = persona.chat.add_message(
        NewMessage(
            body=fallback,
            sender=persona.id,
            mime_model=MimeModel(
                data={mime_type: payload, "text/plain": fallback},
                metadata={PROMPT_METADATA_KEY: prompt_id},
            ),
        )
    )
    return {"success": True, "message_id": message_id, "reused": False}
