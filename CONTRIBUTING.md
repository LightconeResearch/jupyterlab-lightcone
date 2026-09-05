# Contributing

Keep Lightcone a small JupyterLab integration. Add dependencies and modules with
the features that use them. Follow [AGENTS.md](AGENTS.md).

## Development environment

Use Python 3.10 or later and Node.js 22 or later. Create a virtual environment
once, then activate it in every terminal before running project commands:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install "jupyterlab==4.6.3" "jupyter-builder>=1.2.0,<2"
jlpm install --immutable
python -m pip install -e ".[dev,test]"
jupyter-builder develop . --overwrite
jupyter labextension list
jupyter lab
```

On Windows, activate with `.venv\Scripts\activate` instead. Use `jlpm` for all
JavaScript package operations and commit its `yarn.lock` changes when dependencies
change. Run `jlpm install` to update the lockfile after editing dependencies.

The editable installation builds the frontend and installs the Python package.
The develop command links the build to JupyterLab. The extension currently has
no server runtime, so no Lightcone server-extension enable command is needed.

## Iteration

In an activated environment:

```bash
jlpm build
```

Refresh the browser after rebuilding. Alternatively run `jlpm watch` and start
`jupyter lab` in another activated terminal. Restart JupyterLab after Python
changes; reinstall and relink after package structure or discovery changes.

## Verification

Run from the repository root in the activated environment:

```bash
jlpm typecheck
jlpm lint:check
jlpm build
python -m py_compile jupyterlab_lightcone/__init__.py
python -m pytest -q --cov=jupyterlab_lightcone
python .github/scripts/check_auth.py
```

The Python test checks installed package metadata and prebuilt asset discovery.
The authentication checker skips this frontend-only stage; it must check all
registered handlers when a server extension is added.

The installed-browser smoke test verifies activation, startup errors, and the
absence of Lightcone API requests. See [ui-tests/README.md](ui-tests/README.md).
Add focused unit tests when behavior is introduced; there is no unused
JavaScript unit-test runner in this foundation.

CI also installs the wheel in environments without Node.js. See
[RELEASE.md](RELEASE.md) for local package verification.

## Development uninstall

With the environment activated:

```bash
python -m pip uninstall jupyterlab-lightcone
```

Remove the development link reported by `jupyter labextension list` if it remains.
