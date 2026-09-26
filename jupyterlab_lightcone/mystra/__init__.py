"""TEMPORARY: the managed MySTRA Viewer, a stopgap to remove when possible.

MyST offers no supported way to embed a running ``myst start`` site in
JupyterLab, so this server extension spawns the MyST CLI and proxies its
theme and content servers through Jupyter-authenticated routes. It works only
with ASTRA themes implementing the private ``mystra-viewer.v1`` contract.

Everything the viewer needs lives in this package and in ``src/mystra/``;
nothing else in Lightcone imports it. Removing the viewer means deleting both
directories and their single registrations: the extension point in
``jupyterlab_lightcone/__init__.py``, the plugin in ``src/index.ts`` and the
stylesheet import in ``style/index.css``.
"""

from .application import MySTRAApp

__all__ = ["MySTRAApp"]
