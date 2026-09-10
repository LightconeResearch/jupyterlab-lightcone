"""Deterministic agent that exercises the real MCP routing and streamed replies."""
import asyncio
import os

from jupyter_ai_persona_manager import BasePersona, McpServerHttp, PersonaDefaults
from jupyterlab_chat.models import Message
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


class LightconePersona(BasePersona):
    @property
    def defaults(self) -> PersonaDefaults:
        return PersonaDefaults(
            name="Lightcone test agent",
            description="Local integration test; no model or external service.",
            avatar_path=os.environ["LIGHTCONE_TEST_AVATAR"],
            system_prompt="unused",
        )

    async def process_message(self, message: Message) -> None:
        if (message.metadata or {}).get("lightcone") is not None:
            raise RuntimeError("Unexpected Lightcone context metadata")
        if message.body.startswith("Compare the options."):
            self.send_message("Agent received: " + message.body)
            return
        server = next(s for s in self.get_mcp_settings().mcp_servers if isinstance(s, McpServerHttp))
        headers = {header.name: header.value for header in server.headers}
        async with (
            streamablehttp_client(server.url, headers=headers) as (read, write, _),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            available = await session.list_tools()
            lightcone_tools = {tool.name for tool in available.tools if tool.name.startswith("lightcone_")}
            if lightcone_tools != {"lightcone_preview_element", "lightcone_open_element"}:
                raise RuntimeError(f"Unexpected Lightcone tools: {lightcone_tools}")
            entrypoint = os.path.relpath(
                os.path.join(self.get_chat_dir(), "astra.yaml"), self.parent.root_dir
            )
            result = await session.call_tool("lightcone_open_element", {"entrypoint": entrypoint, "target": "decisions.method"})
            if result.isError or not result.structuredContent.get("success"):
                raise RuntimeError(str(result))

            for target in ["decisions.method", "outputs.figure", "outputs.figure"]:
                preview = await session.call_tool("lightcone_preview_element", {"entrypoint": entrypoint, "target": target})
                if preview.isError or not preview.structuredContent.get("success"):
                    raise RuntimeError(str(preview))

        async def chunks():
            yield "Use {astra}`decisions."
            await asyncio.sleep(0.2)
            yield "method` and {astra}`the figure <outputs.figure>`."
            await asyncio.sleep(0.2)
            yield "\n\nLiteral example: ``{astra}`outputs.figure` ``."

        await self.stream_message(chunks())
