"""The extension's shutdown hook never lets a viewer failure reach Jupyter Server's own cleanup."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from ..application import MySTRAApp


def stopping_app(manager=None):
    """The attributes `stop_extension` reads, without starting a server; `manager` is None before the handlers exist."""
    return SimpleNamespace(serverapp=SimpleNamespace(web_app=SimpleNamespace(settings={})), log=Mock(), manager=manager)


async def test_the_viewer_is_stopped():
    manager = SimpleNamespace(close=AsyncMock())
    app = stopping_app(manager)
    await MySTRAApp.stop_extension(app)
    manager.close.assert_awaited_once()
    app.log.warning.assert_not_called()


async def test_a_failed_viewer_shutdown_does_not_fail_the_server_cleanup():
    app = stopping_app(SimpleNamespace(close=AsyncMock(side_effect=OSError("myst"))))
    await MySTRAApp.stop_extension(app)
    app.log.warning.assert_called_once()


async def test_a_cancelled_shutdown_is_not_swallowed():
    """Only failures are isolated; cancellation still reaches Jupyter Server."""
    with pytest.raises(asyncio.CancelledError):
        await MySTRAApp.stop_extension(stopping_app(SimpleNamespace(close=AsyncMock(side_effect=asyncio.CancelledError))))


async def test_without_a_viewer_manager_nothing_stops():
    app = stopping_app()
    await MySTRAApp.stop_extension(app)
    app.log.warning.assert_not_called()
