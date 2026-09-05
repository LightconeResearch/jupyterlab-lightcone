# JupyterLab Lightcone

[![Github Actions Status](https://github.com/LightconeResearch/jupyterlab-lightcone/workflows/Build/badge.svg)](https://github.com/LightconeResearch/jupyterlab-lightcone/actions/workflows/build.yml)

The open AI workbench for scientific research.

Open `astra.yaml` using **Open With → Lightcone Viewer** to validate a project
and see its analysis name, universe, and analysis/record counts. Missing files,
permission failures, and SDK validation issues appear in the document. The viewer
is read-only and starts no kernels. Other YAML files keep their usual viewers.
Close and reopen to reload saved project changes at this stage. JupyterLab's
standard text context may create an initial `.ipynb_checkpoints` backup for a
writable file; Lightcone does not save analysis content.

This implements migration stages 1 and 2. Inventory navigation, artifact previews,
refresh, paper access, publications, and optional shell theming follow in later
stages. Lightcone is the product name; ASTRA remains the analysis format.

## Compatibility and installation

The tested baseline is JupyterLab 4.6.3 with Python 3.10 and 3.14. The package
targets JupyterLab 4.6.x; other JupyterLab minor releases are not yet verified.

Activate your JupyterLab environment, then install the prebuilt Python package:

```bash
source /path/to/venv/bin/activate
pip install jupyterlab-lightcone
jupyter labextension list
jupyter lab
```

The extension should appear as `@lightcone-research/jupyterlab-lightcone`, enabled
and OK. A wheel includes the frontend and published `@astra-spec/sdk` dependency;
installation needs neither Node.js nor sibling repositories. The Python package
`jupyterlab_lightcone` provides frontend discovery only. There is currently no
Lightcone server extension to enable.

The viewer uses the configured JupyterLab Contents manager, including named
drives and project subdirectories. It rejects invalid project-relative paths
before reading. The Contents provider remains responsible for filesystem access
and symlink containment: the standard Contents API does not expose real paths.
The adapter delegates parsing, validation, universe selection, indexing, and
artifact bindings to the SDK.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the environment, build, installation,
and testing workflow, and [RELEASE.md](RELEASE.md) for automated releases.
[AGENTS.md](AGENTS.md) contains the project's coding standards.

To uninstall, activate the same environment and run `pip uninstall
jupyterlab-lightcone`. If a development link was installed, remove it as described
in the contributing guide.
