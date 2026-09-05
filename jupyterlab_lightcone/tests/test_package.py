"""Check the metadata and assets used by installed-extension discovery."""

import json
import sys
from importlib.metadata import version
from pathlib import Path

import jupyterlab_lightcone


def test_installed_frontend():
    """The installed Python distribution exposes a matching prebuilt frontend."""
    [extension] = jupyterlab_lightcone._jupyter_labextension_paths()
    destination = (
        Path(sys.prefix) / "share" / "jupyter" / "labextensions" / extension["dest"]
    )
    package = json.loads((destination / "package.json").read_text())

    assert package["name"] == extension["dest"]
    assert package["version"] == jupyterlab_lightcone.__version__
    assert version("jupyterlab-lightcone") == jupyterlab_lightcone.__version__
    assert (destination / package["jupyterlab"]["_build"]["load"]).is_file()
    assert (destination / "static" / "style.js").is_file()
