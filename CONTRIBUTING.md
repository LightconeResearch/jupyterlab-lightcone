# Contributing

## Development install

Use Python 3.10 or 3.14 and JupyterLab 4.6.3, the tested compatibility baseline.
Building requires Node.js (tested with 26.8.1). Use `jlpm` exclusively for
JavaScript dependencies and scripts; keep `yarn.lock` as the only lockfile.

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install 'jupyterlab==4.6.3' 'jupyter-builder>=1.2.0,<2'
jlpm install
jlpm build
pip install -e '.[dev,test]'
jupyter-builder develop . --overwrite
jupyter labextension list
jupyter lab
```

Activate `.venv` in every terminal before running commands. Building compiles
and bundles the frontend; editable installation and `jupyter-builder develop`
register it with JupyterLab. No Lightcone server extension is present in stages
1–2, so there is no server enable step.

After TypeScript or CSS changes, run `jlpm build` and refresh the browser.
Alternatively, run `jlpm watch` in one activated terminal and `jupyter lab` in
another. Restart JupyterLab after Python changes. Reinstall if package structure
or discovery changes.

## Checks

```bash
source .venv/bin/activate
jlpm tsc --noEmit
jlpm lint:check
jlpm test --runInBand
jlpm build
python -m py_compile jupyterlab_lightcone/__init__.py
pytest -vv -r ap --cov jupyterlab_lightcone
python .github/scripts/check_auth.py
```

The reader tests exercise real SDK resolution, path boundaries, named drives,
malformed Contents responses, and missing versus failed reads. It makes one
Contents request per SDK operation (three for a minimal project: entrypoint stat,
text read, and optional universe-directory stat). No artifact-layout cache or
batching is introduced before a measured need. Browser tests exercise the
installed document viewer; see [ui-tests/README.md](ui-tests/README.md).

Python tests check the packaged frontend discovery. The authentication checker
reports that no endpoints are registered at this stage; its runtime check is
retained for future server functionality. Every future handler verb must be
authenticated, and user-data routes must also apply authorization as described
in [AGENTS.md](AGENTS.md).

## Development uninstall

In the activated environment, run `pip uninstall jupyterlab-lightcone`.
Use `jupyter labextension list` to locate and remove the development symlink
`@lightcone-research/jupyterlab-lightcone` created by `jupyter-builder develop`.

## Packaging

```bash
source .venv/bin/activate
pip install build
jlpm build:prod
python -m build
```

CI installs the resulting wheel in a separate job without Node.js and checks
frontend discovery. Integration tests open projects in the installed prebuilt
extension. See [RELEASE.md](RELEASE.md) for publishing.
