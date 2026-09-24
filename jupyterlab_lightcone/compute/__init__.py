"""Dask clusters the Lightcone sidebar starts and `lc materialize` attaches to.

The extension starts, reports on and stops clusters on three backends (this
host, Slurm, Dask Gateway) and records each one under `~/.lightcone/clusters/`,
where the engine finds it. docs/design/compute-clusters.md describes the
design and the contract between the two.
"""

from .routes import close_compute, setup_compute_handlers

__all__ = ["close_compute", "setup_compute_handlers"]
