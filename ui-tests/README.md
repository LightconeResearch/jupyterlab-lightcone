# Browser integration tests

These tests use Playwright and JupyterLab's Galata helpers to verify the installed
extension. The smoke test checks real plugin activation, browser errors, and
unwanted Lightcone API requests during startup.

First complete the installation in [CONTRIBUTING.md](../CONTRIBUTING.md).
From the repository root:

```bash
source .venv/bin/activate
cd ui-tests
jlpm install --immutable
jlpm playwright install chromium
jlpm test
```

Playwright starts a test JupyterLab server and stops it when the tests finish.
The test configuration binds to localhost and exposes the JupyterLab application
object for Galata; use it only for testing. Test output is written to
`test-results/` and `playwright-report/`.

To verify a wheel, install it in a separate virtual environment and activate
that environment before running these commands. The frontend is served from
the installed wheel; Playwright's JavaScript dependencies are test tooling.

CI runs against the built wheel. If snapshots are introduced in later stages,
update them with `jlpm test:update` and review the image changes.
