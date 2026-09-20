"""MCP tools for the originating JupyterLab browser.

Imports are lazy so the inventory works without the optional AI dependencies.
"""

TOOLS = [
    "jupyterlab_lightcone.agent_tools:lightcone_preview_element",
    "jupyterlab_lightcone.agent_tools:lightcone_open_element",
]


def _origin_manager():
    """Find the calling chat's persona manager from Jupyter AI's MCP headers."""
    from fastmcp.server.dependencies import get_http_headers
    from jupyter_server.serverapp import ServerApp

    managers = ServerApp.instance().web_app.settings.get("jupyter-ai", {}).get(
        "persona-managers", {}
    )
    return managers.get(get_http_headers().get("x-jupyter-chat-id"))


def _origin_entrypoint() -> str | None:
    """Contents path of the astra.yaml that owns the calling chat's folder."""
    from pathlib import Path

    from .projects import owning_project

    manager = _origin_manager()
    if manager is None:
        return None
    root = Path(manager.root_dir).resolve()
    project = owning_project(root, Path(manager.get_chat_path(relative=True)).parent)
    if project is None:
        return None
    return (project.relative_to(root) / "astra.yaml").as_posix()


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
                "NO_PROJECT: This chat is not stored inside an ASTRA project "
                "(no astra.yaml at or above its folder)."
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


def _origin_persona():
    """Resolve the calling persona using the same registry as MCP routing.

    This small compatibility adapter targets Jupyter AI 3.2. Frontend
    sendMessage attributes messages to the human, so publish through the
    persona's chat model instead.
    """
    from fastmcp.server.dependencies import get_http_headers
    from jupyterlab_commands_toolkit.tools import target_client_id

    headers = get_http_headers()
    manager = _origin_manager()
    persona = (
        manager.personas.get(headers.get("x-jupyterai-persona-id"))
        if manager else None
    )
    message = getattr(persona, "processing_message", None)
    client = target_client_id.get()
    if (
        not client
        or message is None
        or (message.metadata or {}).get("web_client_id") != client
        or persona.chat.get_id() != headers.get("x-jupyter-chat-id")
    ):
        return None
    return persona


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
    mime_type = "application/vnd.lightcone.astra+json"
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
            and (mime.metadata or {}).get("lightcone_prompt") == prompt_id
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
                metadata={"lightcone_prompt": prompt_id},
            ),
        )
    )
    return {"success": True, "message_id": message_id, "reused": False}
