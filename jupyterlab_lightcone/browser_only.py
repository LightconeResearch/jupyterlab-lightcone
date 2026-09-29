"""The server side of a browser-only install: a line in the log, and no routes.

`pip install jupyterlab-lightcone` installs the prebuilt frontend and this
package without its dependencies, which is all a JupyterLab one cannot
configure (a managed JupyterHub, say) takes. The `full` extra adds what the
routes need: the Lightcone engine, astra-tools, git history, Jupyter AI and
Jupyter Chat. The frontend tells the two apart by the page option that
`LightconeApp` publishes (`application.SERVER_OPTION`).
"""

import importlib
import importlib.util

from jupyter_server.extension.application import ExtensionApp

FULL_INSTALL = "pip install 'jupyterlab-lightcone[full]'"
"""The command that adds the server features."""


def _installed(package: str) -> bool:
    """Whether a top-level package can be found, without importing it."""
    try:
        return importlib.util.find_spec(package) is not None
    except (ImportError, ValueError):
        # `ValueError` for a package set to None in `sys.modules`, which Python
        # refuses to import.
        return False


def missing_dependency() -> str | None:
    """The first package the routes need that is not installed; None when all are.

    Importing the application is the test: it imports every route module, and
    they import their dependencies at module level. A module missing from a
    package that is installed is a broken install, as is a missing module of
    this package itself, never a lighter one: both are raised, so the server
    reports the failure instead of quietly running browser-only.
    """
    try:
        importlib.import_module(".application", __package__)
    except ModuleNotFoundError as error:
        root = (error.name or "").partition(".")[0]
        if not root or root == __package__ or _installed(root):
            raise
        return root
    return None


class BrowserOnlyApp(ExtensionApp):
    """Say in the server log that Lightcone Lab runs in the browser only, and why."""

    name = "jupyterlab_lightcone"

    def initialize_settings(self):
        """Name the missing dependency and the install that adds it."""
        self.log.info(
            "Lightcone Lab runs in the browser only: %s is not installed. "
            "Agents, run history, freshness and the paper cache need %s.",
            missing_dependency(),
            FULL_INSTALL,
        )
