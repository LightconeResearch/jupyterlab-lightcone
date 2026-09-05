"""Verify the prebuilt frontend's Python discovery contract."""
import json
import sysconfig
from pathlib import Path

import jupyterlab_lightcone


def test_prebuilt_extension():
    """The Python package discovers a bundled frontend without server hooks."""
    paths = jupyterlab_lightcone._jupyter_labextension_paths()
    assert paths == [{
        "src": "labextension",
        "dest": "@lightcone-research/jupyterlab-lightcone",
    }]
    extension = (Path(sysconfig.get_path("data")) / "share" / "jupyter"
                 / "labextensions" / paths[0]["dest"])
    metadata = json.loads((extension / "package.json").read_text())
    assert metadata["name"] == paths[0]["dest"]
    assert (extension / metadata["jupyterlab"]["_build"]["load"]).is_file()
    assert "discovery" not in metadata["jupyterlab"]
    assert not hasattr(jupyterlab_lightcone, "_jupyter_server_extension_points")
