# Releasing JupyterLab Lightcone

Releases are managed by the existing Jupyter Releaser GitHub Actions workflows.
`package.json` is the version source; Python metadata derives its version through
`hatch-nodejs-version`. Change versions only as part of an explicitly requested
release.

## Validate packages locally

Follow [CONTRIBUTING.md](CONTRIBUTING.md) to set up the development environment.
Then, from the repository root:

```bash
source .venv/bin/activate
jlpm install
jlpm lint:check
jlpm test --runInBand
pip install build
jlpm build:prod
python -m build
```

The source distribution and wheel in `dist/` include the prebuilt extension.
Install the wheel in a separate activated environment with JupyterLab 4.6.3 and
check `jupyter labextension list`, then open `astra.yaml` with **Lightcone Viewer**.
Wheel installation requires no Node.js, frontend build, sibling checkout, or
Lightcone server enable step. Use `jlpm` for all JavaScript package operations.

## Publish with GitHub Actions

The repository needs the Jupyter Releaser configuration described in its
[setup checklist](https://jupyter-releaser.readthedocs.io/en/latest/how_to_guides/convert_repo_from_repo.html),
including the release environment and required publishing credentials or trusted
publishers.

1. Run **Step 1: Prep Release** in GitHub Actions.
2. Review the prepared changelog, version, and packages.
3. Run **Step 2: Publish Release**.

See the [Jupyter Releaser workflow documentation](https://jupyter-releaser.readthedocs.io/en/latest/get_started/making_release_from_repo.html)
for operational details. Do not publish manually from a development checkout.
