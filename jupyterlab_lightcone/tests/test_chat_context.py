"""Fixed chat bindings are agent context, never edits to persisted messages."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from jupyterlab_lightcone.chat_context import prompt_context, context_provider_available

BINDING = {"version": 1, "entrypoint": "project/astra.yaml", "universeId": "baseline"}


def message(binding=BINDING, body="Compare the options.", deleted=False):
    return SimpleNamespace(
        body=body,
        metadata={} if binding is None else {"lightcone": deepcopy(binding)},
        deleted=deleted,
    )


@pytest.mark.parametrize("universe", ["baseline", "alternate", None])
def test_context_preserves_message_and_names_binding(universe):
    current = message({**BINDING, "universeId": universe})
    before = deepcopy(current)
    text = prompt_context(current, [])
    assert 'ASTRA context: "project/astra.yaml".' in text
    assert (
        "Use project defaults (no universe override)"
        if universe is None
        else f'Use the bound universe "{universe}"'
    ) in text
    assert "lightcone_preview_element" in text
    assert current == before


def test_restores_from_history_and_ignores_deleted_messages():
    history = [message(), message({**BINDING, "universeId": "other"}, deleted=True)]
    assert prompt_context(message(None), history) == prompt_context(message(), [])
    assert prompt_context(None, history) == prompt_context(message(), [])
    assert prompt_context(message(None), []) is None
    assert prompt_context(None, []) is None


@pytest.mark.parametrize(
    "bad",
    [
        {},
        None,
        {**BINDING, "version": True},
        {**BINDING, "version": 2},
        {**BINDING, "entrypoint": "../astra.yaml"},
        {**BINDING, "entrypoint": "/project/astra.yaml"},
        {**BINDING, "entrypoint": "project/other.yaml"},
        {**BINDING, "universeId": 17},
    ],
)
def test_invalid_metadata_fails_before_agent_prompt(bad):
    current = message()
    current.metadata["lightcone"] = bad
    with pytest.raises(ValueError, match="Lightcone chat context"):
        prompt_context(current, [])


@pytest.mark.parametrize(
    "changed",
    [
        {**BINDING, "entrypoint": "another/astra.yaml"},
        {**BINDING, "universeId": None},
    ],
)
def test_conflicting_context_fails(changed):
    with pytest.raises(ValueError, match="conflicting"):
        prompt_context(message(changed), [message()])


def test_optional_ai_and_provider_registration(monkeypatch):
    def missing(name):
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(
        "jupyterlab_lightcone.chat_context.import_module", missing
    )
    assert not context_provider_available()
    module = SimpleNamespace(
        PROMPT_CONTEXT_API_VERSION=1, get_prompt_context_providers=lambda: {}
    )
    monkeypatch.setattr(
        "jupyterlab_lightcone.chat_context.import_module", lambda name: module
    )
    assert not context_provider_available()
    module.get_prompt_context_providers = lambda: {"lightcone": prompt_context}
    assert context_provider_available()
    module.PROMPT_CONTEXT_API_VERSION = 2
    assert not context_provider_available()


@pytest.mark.parametrize("available", [False, True])
async def test_context_capability_endpoint(jp_fetch, monkeypatch, available):
    import json

    monkeypatch.setattr(
        "jupyterlab_lightcone.chat_context.context_provider_available",
        lambda: available,
    )
    response = await jp_fetch("jupyterlab_lightcone", "api", "chat-context")
    assert json.loads(response.body) == {"available": available}
    assert response.headers["Cache-Control"] == "no-store"


async def test_context_capability_requires_auth(jp_fetch):
    response = await jp_fetch(
        "jupyterlab_lightcone",
        "api",
        "chat-context",
        headers={"Authorization": ""},
        follow_redirects=False,
        raise_error=False,
    )
    assert response.code == 403
