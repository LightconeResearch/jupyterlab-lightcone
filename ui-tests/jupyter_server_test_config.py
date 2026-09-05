"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import sys
from pathlib import Path

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

c.ServerApp.ip = "127.0.0.1"
c.ServerApp.port = 8888
c.ServerApp.port_retries = 0

# Test the active installation without inheriting unrelated user extensions.
c.LabServerApp.labextensions_path = [
    str(Path(sys.prefix) / "share" / "jupyter" / "labextensions")
]
