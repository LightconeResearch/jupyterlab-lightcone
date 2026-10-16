"""The default install runs in the browser; `engine` adds the routes, `full` the chats."""

import importlib
import sys
from types import SimpleNamespace

import pytest
from tornado.httpclient import HTTPClientError

import jupyterlab_lightcone
from jupyterlab_lightcone import browser_only
from jupyterlab_lightcone.application import AGENTS_OPTION, SERVER_OPTION

PACKAGE = "jupyterlab_lightcone"


def uninstall(monkeypatch, package):
    """Make `package` look uninstalled, and this package's routes import afresh.

    A `None` entry makes Python refuse the import, for the package and every
    module of it already imported. Only this module's own imports stay, so the
    application is imported again and meets the missing package.
    """
    for name in list(sys.modules):
        if name.startswith(f"{PACKAGE}.") and name != browser_only.__name__:
            monkeypatch.delitem(sys.modules, name)
    for name in list(sys.modules):
        if name.startswith(f"{package}."):
            monkeypatch.setitem(sys.modules, name, None)
    monkeypatch.setitem(sys.modules, package, None)


@pytest.fixture
def without_dulwich(monkeypatch):
    """A server environment without the `engine` extra's git reader."""
    uninstall(monkeypatch, "dulwich")


@pytest.fixture
def without_jupyter_chat(monkeypatch):
    """A server environment with the `engine` extra and without the `full` one."""
    uninstall(monkeypatch, "jupyterlab_chat")


def test_the_full_install_loads_the_routes_and_the_viewer():
    assert browser_only.missing_dependency() is None
    points = jupyterlab_lightcone._jupyter_server_extension_points()
    assert [(point["module"], point["app"].__name__) for point in points] == [
        (PACKAGE, "LightconeApp"),
        (f"{PACKAGE}.mystra", "MySTRAApp"),
    ]


@pytest.mark.parametrize("package", ["lightcone", "astra", "dulwich"])
def test_a_missing_dependency_leaves_the_workbench_to_the_browser(monkeypatch, package):
    uninstall(monkeypatch, package)
    assert browser_only.missing_dependency() == package
    assert jupyterlab_lightcone._jupyter_server_extension_points() == [
        {"module": PACKAGE, "app": browser_only.BrowserOnlyApp}
    ]


def test_a_module_missing_from_an_installed_package_is_a_broken_install(monkeypatch):
    # lightcone itself is installed; one of its modules is not.
    for name in list(sys.modules):
        if name.startswith(f"{PACKAGE}.") and name != browser_only.__name__:
            monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, "lightcone.engine.materialize", None)
    with pytest.raises(ModuleNotFoundError):
        browser_only.missing_dependency()


def test_the_agent_tools_load_without_the_full_extra(monkeypatch):
    from jupyterlab_lightcone import agent_tools

    assert agent_tools.tools() == agent_tools.TOOLS
    uninstall(monkeypatch, "dulwich")
    fresh = importlib.import_module(f"{PACKAGE}.agent_tools")
    assert fresh.tools() == []


def test_a_missing_module_of_this_package_is_a_defect(monkeypatch):
    uninstall(monkeypatch, f"{PACKAGE}.versions")
    with pytest.raises(ModuleNotFoundError):
        browser_only.missing_dependency()


def test_the_log_names_what_is_missing_and_the_install_that_adds_it(without_dulwich):
    messages = []
    app = SimpleNamespace(log=SimpleNamespace(info=lambda message, *args: messages.append(message % args)))
    browser_only.BrowserOnlyApp.initialize_settings(app)
    assert messages == [
        "Lightcone Lab runs in the browser only: dulwich is not installed. "
        "Run history, freshness and the paper cache need "
        "pip install 'jupyterlab-lightcone[engine]'."
    ]


async def test_the_full_server_announces_its_routes(jp_serverapp, jp_fetch):
    page_config = jp_serverapp.web_app.settings["page_config_data"]
    assert page_config[SERVER_OPTION] == "true"
    assert page_config[AGENTS_OPTION] == "true"
    response = await jp_fetch(PACKAGE, "api", "projects", params={"path": "."})
    assert response.code == 200


def test_the_engine_loads_the_routes_without_jupyter_ai(without_jupyter_chat):
    assert browser_only.missing_dependency() is None
    points = jupyterlab_lightcone._jupyter_server_extension_points()
    assert [point["app"].__name__ for point in points] == ["LightconeApp", "MySTRAApp"]


async def test_the_engine_server_announces_its_routes_and_no_chats(without_jupyter_chat, jp_serverapp, jp_fetch):
    page_config = jp_serverapp.web_app.settings["page_config_data"]
    assert page_config[SERVER_OPTION] == "true"
    assert AGENTS_OPTION not in page_config
    response = await jp_fetch(PACKAGE, "api", "projects", params={"path": "."})
    assert response.code == 200
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(PACKAGE, "api", "chat-sessions", params={"path": "astra.yaml"})
    assert error.value.code == 404


async def test_a_browser_only_server_has_no_routes_to_announce(without_dulwich, jp_serverapp, jp_fetch):
    assert SERVER_OPTION not in jp_serverapp.web_app.settings.get("page_config_data", {})
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(PACKAGE, "api", "projects", params={"path": "."})
    assert error.value.code == 404
