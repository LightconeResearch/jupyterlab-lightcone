"""Which chats have an agent at work, from Jupyter AI's own persona events.

Every persona publishes a `persona_state` Jupyter Event whose `processing`
flag brackets its work on a message (the frontend's stop button reads the
same event). The server keeps the last flag per chat and persona, so the
session listing can say which sessions are working without depending on the
class that routes messages.
"""

PROCESSING_PERSONAS = "lightcone_processing_personas"
"""The web application setting mapping a chat id to the ids of the personas processing a message in it."""


def processing_personas(settings: dict) -> dict[str, set[str]]:
    """The personas at work, by chat id; the one map the listener writes and the listing reads."""
    return settings.setdefault(PROCESSING_PERSONAS, {})


def working_chats(settings: dict) -> set[str]:
    """The ids of the chats in which a persona is processing a message."""
    return {chat_id for chat_id, personas in processing_personas(settings).items() if personas}


def record_persona_state(settings: dict, data: dict) -> None:
    """Apply one `persona_state` event; events without a `processing` flag are other state."""
    processing = data.get("processing")
    chat_id, persona_id = data.get("chat_id"), data.get("persona_id")
    if not isinstance(processing, bool) or not isinstance(chat_id, str) or not isinstance(persona_id, str):
        return
    registry = processing_personas(settings)
    if processing:
        registry.setdefault(chat_id, set()).add(persona_id)
        return
    personas = registry.get(chat_id)
    if personas is not None:
        personas.discard(persona_id)
        if not personas:
            del registry[chat_id]


def watch_persona_activity(serverapp) -> None:
    """Follow every persona's `processing` flag for the life of the server.

    Listeners run as tasks in emission order, so a persona's start and end
    are applied in the order it published them.
    """
    try:
        from jupyter_ai_persona_manager.persona_events import PERSONA_STATE_EVENT_SCHEMA_ID
    except ImportError:
        # Activity is optional, just like selecting the project-aware manager.
        return
    settings = serverapp.web_app.settings

    async def on_persona_state(logger, schema_id, data) -> None:
        record_persona_state(settings, data)

    serverapp.event_logger.add_listener(schema_id=PERSONA_STATE_EVENT_SCHEMA_ID, listener=on_persona_state)
