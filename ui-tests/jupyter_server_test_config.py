"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import atexit
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from astra.papers.cache import PaperCache
from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Keep the user's real ASTRA cache untouched and avoid external PDF downloads.
paper_cache = TemporaryDirectory(prefix="lightcone-galata-papers-")
atexit.register(paper_cache.cleanup)
os.environ["LIGHTCONE_PAPER_CACHE_DIR"] = paper_cache.name
PaperCache(Path(paper_cache.name)).add_from_file(
    "10.1234/continuous-test",
    Path(__file__).parent / "fixtures" / "paper.pdf",
    title="Continuous scrolling test paper",
    authors=["Test Author"],
)
