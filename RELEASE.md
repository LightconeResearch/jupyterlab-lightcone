# Making a new release of Lightcone Lab

Publish a release through the GitHub interface to distribute the extension on
PyPI. The Python wheel includes the prebuilt frontend and server extension, so
users install it with `pip install jupyterlab-lightcone` and restart JupyterLab.
The release workflow does not publish to npm.

## One-time setup

1. In the GitHub repository's **Settings → Environments**, create an environment
   named `release`. If you restrict deployment branches and tags, allow the release
   tags you intend to publish.
2. Configure a [PyPI trusted publisher](https://docs.pypi.org/trusted-publishers/adding-a-publisher/)
   with these exact values:

   | Setting           | Value                  |
   | ----------------- | ---------------------- |
   | PyPI project      | `jupyterlab-lightcone` |
   | GitHub owner      | `LightconeResearch`    |
   | Repository        | `jupyterlab-lightcone` |
   | Workflow filename | `publish-release.yml`  |
   | Environment       | `release`              |

   For the first release of a new PyPI project, use a
   [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).

No PyPI API token, `NPM_TOKEN`, `APP_ID`, or `APP_PRIVATE_KEY` is required. The
publish job uses GitHub's OIDC identity with `id-token: write` to authenticate to
PyPI. Build steps run in a separate job without publishing credentials.

## Publish a release

1. Wait for **Build** and **Check Release** to pass on the commit to release.
   **Check Release** uses Jupyter Releaser only to validate packaging; it does not
   publish packages.
2. Open **Releases → Draft a new release** in GitHub. Create a tag at the tested
   commit for the version you want to publish, optionally prefixed with `v`.
   For example, tag `0.0.2` or `v0.0.2` publishes version `0.0.2`. No separate
   version-bump commit is needed.
3. Write or generate the release notes, then click **Publish release**. Saving a
   draft or pushing a tag alone does not publish to PyPI.
4. Watch the **Publish to PyPI** workflow in Actions. It checks out the release
   tag, sets the package version from that tag, builds and checks the wheel and
   source distribution, and publishes both to PyPI. Approve the `release`
   environment deployment if you configured required reviewers.
5. In an activated environment with Python >= 3.11 and JupyterLab >= 4.5.10, < 5,
   install the release and verify both extensions:

   ```bash
   python -m pip install --upgrade jupyterlab-lightcone
   jupyter labextension list
   jupyter server extension list
   ```

   Restart JupyterLab and check that Lightcone Lab opens an `astra.yaml` file.

The workflow updates `package.json` only in its build checkout, before building
the frontend and Python distributions. Hatch derives the Python version from
that file. The workflow does not change the version committed on `main` or modify
the release tag; the published packages contain the version selected in GitHub.

Release tags must use `MAJOR.MINOR.PATCH`, optionally prefixed with `v`.
The workflow also publishes GitHub prereleases to PyPI: append `-alpha.N`,
`-beta.N`, or `-rc.N` to the tag (for example, `v0.1.0-rc.1`). Marking a GitHub
release as a prerelease alone does not change the package version. Users can
install prereleases with `pip install --pre jupyterlab-lightcone`.

If a workflow fails before uploading to PyPI, fix the cause and rerun the failed
jobs when the tagged source does not need changing. If the source needs a fix,
publish a new version from a new tag. PyPI does not allow replacing already
uploaded distribution files.

## Publishing to `conda-forge`

Conda-forge distribution is optional and requires a separate feedstock. Follow
the [new package guide](https://conda-forge.org/docs/maintainer/adding_pkgs.html)
to add one. Once a feedstock exists, its update bot can propose new releases
after they are published to PyPI.
