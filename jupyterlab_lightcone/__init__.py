"""Python distribution of the prebuilt Lightcone JupyterLab extension."""

from ._version import __version__


def _jupyter_labextension_paths():
    """Tell JupyterLab where to discover the bundled frontend extension."""
    return [{
        "src": "labextension",
        "dest": "@lightcone-research/jupyterlab-lightcone",
    }]
