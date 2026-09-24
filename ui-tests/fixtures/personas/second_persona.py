"""A second deterministic agent, to check which agent a chat opens with."""
import os

from jupyter_ai_persona_manager import BasePersona, PersonaDefaults
from jupyterlab_chat.models import Message


class SecondPersona(BasePersona):
    @property
    def defaults(self) -> PersonaDefaults:
        return PersonaDefaults(
            name="Second test agent",
            description="Local integration test; names itself in its reply.",
            avatar_path=os.environ["LIGHTCONE_TEST_AVATAR"],
            system_prompt="unused",
        )

    async def process_message(self, message: Message) -> None:
        self.send_message(f"Second test agent received: {message.body}")
