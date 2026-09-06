# Making a new release of Lightcone Lab

The extension can be published to `PyPI` and `npm` manually or using the [Jupyter Releaser](https://github.com/jupyter-server/jupyter_releaser).

Releases are handled through GitHub Actions. Keep `package.json` as the version
source; the Python package version is derived automatically. Activate the
project environment before running local packaging or verification commands.

## Automated releases with the Jupyter Releaser

The extension repository should already be compatible with the Jupyter Releaser. But
the GitHub repository and the package managers need to be properly set up. Please
follow the instructions of the Jupyter Releaser [checklist](https://jupyter-releaser.readthedocs.io/en/latest/how_to_guides/convert_repo_from_repo.html).

For the release workflows in this repository, make sure GitHub is configured with:

- a `release` environment
- an `APP_PRIVATE_KEY` secret
- an `APP_ID` repository variable

When using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), `NPM_TOKEN` is not required (and trusted publishing is recommended). Configure `NPM_TOKEN` only if you are publishing without trusted publishers.

Here is a summary of the steps to cut a new release:

- Go to the Actions panel
- Run the "Step 1: Prep Release" workflow
- Check the draft changelog
- Run the "Step 2: Publish Release" workflow

> [!NOTE]
> Check out the [workflow documentation](https://jupyter-releaser.readthedocs.io/en/latest/get_started/making_release_from_repo.html)
> for more information.

## Publishing to `conda-forge`

If the package is not on conda forge yet, check the documentation to learn how to add it: https://conda-forge.org/docs/maintainer/adding_pkgs.html

Otherwise a bot should pick up the new version publish to PyPI, and open a new PR on the feedstock repository automatically.
