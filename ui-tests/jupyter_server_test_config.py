"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import atexit
import json
import os
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Keep the user's real ASTRA cache untouched and avoid external PDF downloads.
paper_cache = TemporaryDirectory(prefix="lightcone-galata-papers-")
atexit.register(paper_cache.cleanup)
os.environ["LIGHTCONE_PAPER_CACHE_DIR"] = paper_cache.name
paper = Path(paper_cache.name) / "continuous-test"
paper.mkdir()
copyfile(Path(__file__).parent / "fixtures" / "paper.pdf", paper / "paper.pdf")
(paper / "meta.json").write_text(
    json.dumps({
        "doi": "10.1234/continuous-test",
        "title": "Continuous scrolling test paper",
        "authors": ["Test Author"],
    }),
    encoding="utf-8",
)
