"""Which sessions have an agent at work, from the persona events Jupyter AI publishes."""
from types import SimpleNamespace

from jupyter_ai_persona_manager.persona_events import (
    PERSONA_STATE_EVENT_SCHEMA_ID,
    register_persona_event_schemas,
)
from jupyter_events.logger import EventLogger

from jupyterlab_lightcone.agent_activity import record_persona_state, watch_persona_activity, working_chats

CODEX = "jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona"
CLAUDE = "jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona"


def test_a_chat_works_while_any_of_its_personas_processes():
    settings = {}
    record_persona_state(settings, {"chat_id": "a", "persona_id": CODEX, "processing": True})
    record_persona_state(settings, {"chat_id": "a", "persona_id": CLAUDE, "processing": True})
    record_persona_state(settings, {"chat_id": "b", "persona_id": CODEX, "processing": True})
    assert working_chats(settings) == {"a", "b"}
    record_persona_state(settings, {"chat_id": "a", "persona_id": CODEX, "processing": False})
    assert working_chats(settings) == {"a", "b"}
    record_persona_state(settings, {"chat_id": "a", "persona_id": CLAUDE, "processing": False})
    record_persona_state(settings, {"chat_id": "b", "persona_id": CODEX, "processing": False})
    assert working_chats(settings) == set()


def test_other_persona_state_and_malformed_events_change_nothing():
    settings = {}
    for data in (
        {"chat_id": "a", "persona_id": CODEX, "usage": {"tokens": 1}},
        {"chat_id": "a", "persona_id": CODEX, "processing": "yes"},
        {"chat_id": 1, "persona_id": CODEX, "processing": True},
        {"chat_id": "a", "processing": True},
        {"chat_id": "never", "persona_id": CODEX, "processing": False},
    ):
        record_persona_state(settings, data)
    assert working_chats(settings) == set()


async def test_the_listener_follows_the_events_the_manager_emits():
    logger = EventLogger()
    register_persona_event_schemas(logger)
    settings = {}
    watch_persona_activity(SimpleNamespace(web_app=SimpleNamespace(settings=settings), event_logger=logger))
    logger.emit(schema_id=PERSONA_STATE_EVENT_SCHEMA_ID, data={"chat_id": "a", "persona_id": CODEX, "processing": True})
    await logger.gather_listeners()
    assert working_chats(settings) == {"a"}
    logger.emit(schema_id=PERSONA_STATE_EVENT_SCHEMA_ID, data={"chat_id": "a", "persona_id": CODEX, "processing": False})
    await logger.gather_listeners()
    assert working_chats(settings) == set()
