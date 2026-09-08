"""MCP tools for the originating JupyterLab browser.

Imports are lazy so the inventory works without the optional AI dependencies.
"""

TOOLS = [
    "jupyterlab_lightcone.agent_tools:lightcone_preview_element",
    "jupyterlab_lightcone.agent_tools:lightcone_open_element",
    "jupyterlab_lightcone.agent_tools:lightcone_read_element",
    "jupyterlab_lightcone.agent_tools:lightcone_project_context",
]


async def _command(name: str, args: dict) -> dict:
    """Require upstream's per-call browser routing; never broadcast."""
    from fastmcp.server.dependencies import get_http_headers
    from jupyterlab_commands_toolkit.tools import execute_command, target_client_id

    if not target_client_id.get():
        return {
            "success": False,
            "error": (
                "NO_ACTIVE_CLIENT: Send a message from Jupyter AI "
                "in the browser first."
            ),
        }
    headers = get_http_headers()
    result = await execute_command(
        f"jupyterlab_lightcone:{name}",
        {**args, "chatId": headers.get("x-jupyter-chat-id", "")},
    )
    if not result.get("success") and "timed out" in str(result.get("error", "")).lower():
        return {
            **result,
            "status": "unconfirmed",
            "retry": "Retrying is safe; repeated opens and previews are reused.",
        }
    return result


async def lightcone_open_element(
    entrypoint: str,
    target: str = "",
    universeId: str | None = None,
    doi: str | None = None,
) -> dict:
    """Open an ASTRA element as a tab in the browser that sent this prompt.

    entrypoint is a Jupyter Contents path to astra.yaml. target is a rooted
    MySTRA path, e.g. decisions.covariance_source or clustering.outputs.xi.
    For a cited paper, pass doi and leave target empty. Inspect real targets
    with lightcone_project_context first. Opens reuse the unpinned ASTRA preview
    in this project and universe. User-pinned tabs are retained; opening an
    already visible record focuses its tab. Pinning is controlled by the user.
    This does not execute recipes or download missing papers. A timeout is
    unconfirmed: the tab may have opened, and retrying is safe.
    """
    return await _command(
        "open-element",
        {
            "entrypoint": entrypoint,
            "target": target,
            "universeId": universeId,
            **({"doi": doi} if doi else {}),
        },
    )


async def lightcone_read_element(
    entrypoint: str,
    target: str = "",
    universeId: str | None = None,
    doi: str | None = None,
) -> dict:
    """Read bounded ASTRA details, relations and artifact availability.

    Paths always start at the project root. Use lightcone_preview_element
    to display a rich card directly in chat, or lightcone_open_element for
    a separate tab. MySTRA roles in prose do not produce preview cards.
    """
    return await _command(
        "read-element",
        {
            "entrypoint": entrypoint,
            "target": target,
            "universeId": universeId,
            **({"doi": doi} if doi else {}),
        },
    )


async def lightcone_project_context(
    entrypoint: str | None = None, query: str = "", offset: int = 0
) -> dict:
    """Discover the conversation's bound ASTRA project and reference targets.

    Omit entrypoint to use this chat's context. Results are paginated, 50 at a
    time, with nextOffset when more remain. query filters paths and labels.
    """
    return await _command(
        "project-context", {"entrypoint": entrypoint, "query": query, "offset": offset}
    )


def _origin_persona():
    """Resolve the calling persona using the same registry as MCP routing.

    This small compatibility adapter targets Jupyter AI 3.2. Frontend
    sendMessage attributes messages to the human, so publish through the
    persona's chat model instead.
    """
    from fastmcp.server.dependencies import get_http_headers
    from jupyter_server.serverapp import ServerApp
    from jupyterlab_commands_toolkit.tools import target_client_id

    headers = get_http_headers()
    managers = ServerApp.instance().web_app.settings.get("jupyter-ai", {}).get(
        "persona-managers", {}
    )
    manager = managers.get(headers.get("x-jupyter-chat-id"))
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


async def lightcone_preview_element(entrypoint: str, target: str) -> dict:
    """Display an ASTRA preview card directly in the originating chat.

    This is the default way to show figures, decisions, inputs, findings,
    prior insights or analyses. Inspect real targets with
    lightcone_project_context first. target is rooted at astra.yaml, e.g.
    outputs.fit or clustering.decisions.method. The chat's universe is used.
    The card has an Open in tab button; use lightcone_open_element when a
    separate tab is explicitly wanted. Do not emit JSON or MySTRA roles in
    prose to create cards. No recipes execute and no papers are downloaded.
    Repeated previews of the same target in one prompt reuse the card.
    """
    result = await _command("read-element", {"entrypoint": entrypoint, "target": target})
    if not result.get("success"):
        return result
    persona = _origin_persona()
    if persona is None:
        return {
            "success": False,
            "error": "NO_ACTIVE_PERSONA: Send a prompt from Jupyter AI first.",
        }

    from jupyterlab_chat.models import MimeModel, NewMessage

    element = result["result"]
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
            return {"success": True, "messageId": message.id, "reused": True}
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
    return {"success": True, "messageId": message_id, "reused": False}
