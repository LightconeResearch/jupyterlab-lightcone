"""TEMPORARY: the managed MySTRA Viewer, a stopgap to remove when possible.

It runs ``myst start`` and proxies it through Jupyter-authenticated routes for
the ``jupyterlab_lightcone:mystra`` frontend plugin. See "TEMPORARY WORKAROUND:
MySTRA Viewer" in AGENTS.md for what belongs to it and how to remove it.
"""

from .application import MySTRAApp

__all__ = ["MySTRAApp"]
