"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import atexit
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from astra.papers.cache import PaperCache
from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Package-index DNS delays must not block the server during browser checks.
c.LabApp.extension_manager = "readonly"

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

# Deterministic optional AI integration; never start the developer's real ACP agents.
c.ContentsManager.allow_hidden = True
c.FileContentsManager.allow_hidden = True
c.PersonaManager.default_persona_id = "jupyter-ai-personas::lightcone_persona::LightconePersona"
c.MCPExtensionApp.mcp_port = int(os.environ.get("LIGHTCONE_TEST_MCP_PORT", "3019"))
os.environ["JUPYTER_AI_ACP_CLIENT_E2E_TESTING_ONLY"] = "1"
os.environ["LIGHTCONE_TEST_AVATAR"] = str(Path(__file__).parent.parent / "style" / "astra-logo.svg")

# Use LabConfig's boolean map, not the deprecated application-settings list.
# Prepending a temporary config also overrides local extension preferences
# without changing the developer's settings.
test_config = TemporaryDirectory(prefix="lightcone-galata-config-")
atexit.register(test_config.cleanup)
labconfig = Path(test_config.name, "labconfig")
labconfig.mkdir()
(labconfig / "page_config.json").write_text(json.dumps({
    "disabledExtensions": {"jupyterlab-myst": os.environ.get("LIGHTCONE_TEST_MYST") != "1"}
}))
os.environ["JUPYTER_CONFIG_PATH"] = os.pathsep.join(filter(None, [
    test_config.name, os.environ.get("JUPYTER_CONFIG_PATH")
]))
