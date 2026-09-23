"""The frontend learns the absolute contents root that agents write paths under."""

import os
from types import SimpleNamespace

from jupyterlab_lightcone.application import LightconeApp


def publishing_app(root_dir):
    """The attributes `_publish_server_root` reads, without starting a server."""
    contents_manager = SimpleNamespace() if root_dir is None else SimpleNamespace(root_dir=root_dir)
    return SimpleNamespace(
        serverapp=SimpleNamespace(contents_manager=contents_manager, web_app=SimpleNamespace(settings={}))
    )


def test_a_root_in_the_home_directory_is_published_in_full():
    """JupyterLab's own `serverRoot` shortens this root to `~/...`."""
    root = os.path.join(os.path.expanduser("~"), "repo", "dev")
    app = publishing_app(root)
    LightconeApp._publish_server_root(app)
    assert app.serverapp.web_app.settings["page_config_data"]["lightconeServerRoot"] == root


def test_other_page_config_is_kept():
    app = publishing_app("/srv/lab/")
    app.serverapp.web_app.settings["page_config_data"] = {"other": 1}
    LightconeApp._publish_server_root(app)
    assert app.serverapp.web_app.settings["page_config_data"] == {
        "other": 1,
        "lightconeServerRoot": "/srv/lab",
    }


def test_a_contents_manager_without_a_local_root_publishes_nothing():
    for root_dir in (None, "", 3):
        app = publishing_app(root_dir)
        LightconeApp._publish_server_root(app)
        assert "lightconeServerRoot" not in app.serverapp.web_app.settings.get("page_config_data", {})


def test_the_running_server_publishes_its_root(jp_serverapp):
    page_config = jp_serverapp.web_app.settings["page_config_data"]
    assert page_config["lightconeServerRoot"] == os.path.abspath(jp_serverapp.contents_manager.root_dir)
