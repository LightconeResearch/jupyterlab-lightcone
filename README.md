# JupyterLab Lightcone

[![Build](https://github.com/LightconeResearch/jupyterlab-lightcone/actions/workflows/build.yml/badge.svg)](https://github.com/LightconeResearch/jupyterlab-lightcone/actions/workflows/build.yml)

The open AI workbench for scientific research.

Lightcone is being rebuilt in small stages. This foundation registers the
extension with JupyterLab; analysis viewing and other user-facing features are
tracked in the [stage issues](https://github.com/LightconeResearch/jupyterlab-lightcone/issues).
It currently adds no commands, settings, or server endpoints. The foundation is
version 0.0.1; version 0.1.0 is reserved for the integrated basic feature set.

The Python distribution `jupyterlab-lightcone` contains the prebuilt frontend
package `@lightcone-research/jupyterlab-lightcone`. The import name is
`jupyterlab_lightcone`. Lightcone is the product brand; ASTRA remains the analysis
format, including the `astra.yaml` entrypoint.

## Compatibility

- JupyterLab 4.6.3 or later within 4.x.
- Python 3.10 or later.
- Node.js 22 or later for development only.

JupyterLab 4.6.3 is the compatibility baseline. CI checks installed wheels on
Python 3.10 and 3.14 and runs the browser smoke test on Python 3.14.
Other supported combinations are not individually verified.

## Install

In your activated JupyterLab environment, install a built wheel:

```bash
python -m pip install /path/to/jupyterlab_lightcone-0.0.1-py3-none-any.whl
jupyter labextension list
jupyter lab
```

The extension should be listed as enabled and OK. Prebuilt wheels require
neither Node.js nor sibling repositories. No Lightcone server extension needs
to be enabled. Restart JupyterLab after the initial installation.

To uninstall in the same environment:

```bash
python -m pip uninstall jupyterlab-lightcone
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and verification,
[AGENTS.md](AGENTS.md) for engineering conventions, and
[RELEASE.md](RELEASE.md) for packaging and the GitHub Actions release workflow.
