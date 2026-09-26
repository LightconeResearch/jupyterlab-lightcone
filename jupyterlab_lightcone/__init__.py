try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_lightcone' outside a proper installation.")
    __version__ = "dev"
from .application import LightconeApp
from .mystra import MySTRAApp


def _jupyter_labextension_paths():
    """Where the prebuilt frontend extension lives, for `jupyter labextension list`."""
    return [{
        "src": "labextension",
        "dest": "jupyterlab-lightcone"
    }]


def _jupyter_server_extension_points():
    """The server extensions Jupyter Server loads for this package."""
    return [
        {"module": "jupyterlab_lightcone", "app": LightconeApp},
        # TEMPORARY: the MySTRA Viewer workaround; see AGENTS.md.
        {"module": "jupyterlab_lightcone.mystra", "app": MySTRAApp},
    ]
