"""MCP tools for the originating JupyterLab browser.

Imports are lazy so the inventory works without the optional AI dependencies.
"""

TOOLS = [
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
            "retry": "Retrying is safe; existing tabs are reused.",
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
    with lightcone_project_context first. Repeated opens reuse the tab.
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

    Cite elements in prose using MySTRA, e.g. {astra}`outputs.fit` or
    {astra}`the fit <outputs.fit>`. Paths always start at the project root.
    Use lightcone_open_element to show a record to the researcher.
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
