"""The extension's shutdown hook never lets one failure strand other processes."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from jupyterlab_lightcone import application
from jupyterlab_lightcone.application import LightconeApp


def stopping_app(manager=None):
    """The attributes `stop_extension` reads, without starting a server."""
    app = SimpleNamespace(serverapp=SimpleNamespace(web_app=SimpleNamespace(settings={})), log=Mock())
    if manager is not None:
        app.manager = manager
    return app


async def test_a_failed_job_shutdown_still_stops_the_viewer(monkeypatch):
    monkeypatch.setattr(application, "close_jobs", AsyncMock(side_effect=PermissionError("killpg")))
    manager = SimpleNamespace(close=AsyncMock())
    app = stopping_app(manager)
    await LightconeApp.stop_extension(app)
    manager.close.assert_awaited_once()
    app.log.warning.assert_called_once()


async def test_a_failed_viewer_shutdown_does_not_fail_the_server_cleanup(monkeypatch):
    close_jobs = AsyncMock()
    monkeypatch.setattr(application, "close_jobs", close_jobs)
    app = stopping_app(SimpleNamespace(close=AsyncMock(side_effect=OSError("myst"))))
    await LightconeApp.stop_extension(app)
    close_jobs.assert_awaited_once_with(app.serverapp.web_app)
    app.log.warning.assert_called_once()


async def test_a_cancelled_shutdown_is_not_swallowed(monkeypatch):
    """Only failures are isolated; cancellation still reaches Jupyter Server."""
    monkeypatch.setattr(application, "close_jobs", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await LightconeApp.stop_extension(stopping_app(SimpleNamespace(close=AsyncMock())))


async def test_without_a_viewer_manager_only_jobs_stop(monkeypatch):
    close_jobs = AsyncMock()
    monkeypatch.setattr(application, "close_jobs", close_jobs)
    app = stopping_app()
    await LightconeApp.stop_extension(app)
    close_jobs.assert_awaited_once()
    app.log.warning.assert_not_called()
