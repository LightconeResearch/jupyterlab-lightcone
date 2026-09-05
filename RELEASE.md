# Packaging and releases

Releases use the repository's GitHub Actions workflows and
[Jupyter Releaser](https://jupyter-releaser.readthedocs.io/en/latest/get_started/making_release_from_repo.html).

During the foundation phase, release checks run only when manually requested.
Automatic link checks are also disabled while the repository is private.
Build, package installation, and browser smoke checks still run on pull requests.

The version in `package.json` is the source of truth. Hatch derives Python
metadata and `jupyterlab_lightcone/_version.py` from it. Change versions only as
part of an explicitly requested release.

## Verify packages locally

Complete the development setup in [CONTRIBUTING.md](CONTRIBUTING.md), then:

```bash
source .venv/bin/activate
jlpm install --immutable
jlpm lint:check
jlpm typecheck
jlpm clean:all
python -m build
```

This builds a source distribution and a wheel containing the prebuilt frontend.
The Python build hook uses `jlpm`. Users installing the wheel do not need Node.js
or sibling checkouts.

Install the wheel in a fresh environment, outside the source checkout:

```bash
python -m venv /tmp/lightcone-wheel-check
source /tmp/lightcone-wheel-check/bin/activate
python -m pip install /absolute/path/to/dist/jupyterlab_lightcone-0.0.1-py3-none-any.whl
cd /tmp
jupyter labextension list
jupyter lab
```

Verify the extension is enabled and OK and run the
[installed-browser smoke test](ui-tests/README.md) against the wheel installation.
CI separately checks wheel installation in Python containers without Node.js.

After packaging, restore your editable installation before resuming development:

```bash
source .venv/bin/activate
python -m pip install -e ".[dev,test]"
jupyter-builder develop . --overwrite
```

Run these restoration commands from the repository root.

## Publish through GitHub Actions

Repository maintainers configure the `release` environment, the `APP_ID`
repository variable, and the `APP_PRIVATE_KEY` secret used by the publish
workflow. Configure registry credentials or trusted publishing for the release
environment as described in the
[Jupyter Releaser checklist](https://jupyter-releaser.readthedocs.io/en/latest/how_to_guides/convert_repo_from_repo.html).

1. Run **Step 1: Prep Release** with the intended version.
2. Review the draft changelog, distributions, and check-release results.
3. Run **Step 2: Publish Release** for the reviewed draft.
4. Verify the published wheel installs and loads in a clean environment.

Local package verification does not publish or tag a release.
