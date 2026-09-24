"""The engine's results layout, spelled once for every route that reads it.

A materialization writes ``results/<universe>/<output>.<format>`` and, beside
it, the hidden run record ``results/<universe>/.<output>.manifest.json``. The
file's name comes from the format the spec declares; the record's name comes
from the output's id alone, so it keeps its history when the format changes.
Only these two names are known here; how a file is found is the version
routes' business (``versions.output_file``).
"""

from pathlib import PurePosixPath

# The engine's own spelling of the sidecar suffix; lightcone-cli has not yet
# declared it stable, so the pin on its version in pyproject.toml guards it.
from lightcone.engine.assets import MANIFEST_SUFFIX

RESULTS_DIRECTORY = "results"
"""Where the engine writes every output and its manifest, relative to the project."""


def manifest_name(output: str) -> str:
    """The name of an output's run record: ``.<output>.manifest.json``."""
    return f".{output}{MANIFEST_SUFFIX}"


def universe_directory(universe: str) -> PurePosixPath:
    """The project-relative folder holding a universe's outputs and their records."""
    return PurePosixPath(RESULTS_DIRECTORY, universe)
