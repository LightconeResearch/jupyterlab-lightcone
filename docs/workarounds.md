# Workarounds around other packages

This inventory grows with the feature that needs each workaround. Each entry
records the dependency boundary, the supported APIs used, the missing upstream
hook, the regression coverage, and the change that lets us delete it. Changes
are confined to this extension; no dependency source is modified.

## MySTRA viewer embedding

**Where.** The self-contained `jupyterlab_lightcone/mystra/` server extension
and `src/mystra/` frontend plugin; `AGENTS.md` lists every file and
registration that belongs to them.

**What and why.** MyST has no supported JupyterLab embedding API for a running
`myst start` application. The extension supervises the CLI's process group and
proxies its theme, content and reload WebSocket through authenticated Jupyter
routes. This works only with ASTRA themes implementing `mystra-viewer.v1`;
`MYSTRA_BASE_URL`, `MYSTRA_CONTENT_URL`, `MYSTRA_RELOAD_URL` and the capability
endpoint are a private contract, not a general MyST interface. The CLI is the
`mystmd` dependency, run by the server's own interpreter
(`python -m mystmd_py.main`) rather than looked up on `PATH`. The viewer relies
on `myst start`'s `--port` and `--server-port` options and its "Server started
on port" log line; `ui-tests/tests/mystra.spec.ts`, run against the real CLI,
fails if a MyST release changes them. Node.js 20 or later remains a system
requirement, and mystmd's offer to download it is declined because it would
prompt on the server's terminal. Keep this stopgap limited to bug fixes,
as required by `AGENTS.md`.

**Public APIs retained.** Viewer activation and closure use Lumino's widget
lifecycle hooks. Closing disposes the widget and its heartbeat; the server's
existing idle lease then expires. Reopening may reuse a warm server process,
while a disposed widget cannot adopt an asynchronous response. Starting a
viewer requires both `execute` on `mystra` and `read` on `contents`, using
Jupyter Server's `authorized` decorators and the ContentsManager's checks.

**Upstream and removal.** A first-party MyST/JupyterLab proxy or static preview
would replace process supervision, proxy routes, capability negotiation and
the companion theme contract. Remove the viewer as `AGENTS.md` describes; do
not add theme adapters.

### Same-server module and font requests under JupyterHub

**Where.** `MySTRAProxyHandler.check_xsrf_cookie` in `mystra/routes.py`.

**What and why.** JupyterHub applies its XSRF check during authentication to
cookie-authenticated CORS resource reads. Browser module imports and fonts
cannot supply a custom XSRF header. For GET/HEAD only, the proxy accepts browser
fetch metadata declaring same-origin and a Referer matching the request scheme,
Host header and this single-user server's base path. All other requests use the
upstream check; authentication, authorization and viewer ownership still apply.
The check cannot call `check_referer` while authentication is in progress,
because that method itself asks for the current user.

**Upstream and removal.** JupyterHub should provide a public resource-read
policy for authenticated proxied applications. Adopt that policy and remove
this override once available.

**Coverage.** `mystra/tests/test_mystra.py` and `test_mystra_auth.py` cover process cleanup,
resource reads, denied origins/base paths and session ownership;
`src/mystra/__tests__/viewer.spec.ts` covers focus, disposal and asynchronous
restart races.
`ui-tests/tests/mystra-lifecycle.spec.ts` exercises real shell close/reopen,
expiry and failure recovery with a controlled upstream. `mystra.spec.ts` also
checks saved-content live reload against the real CLI and compatible theme
when `MYSTRA_TEST_TEMPLATE` is supplied.

## Existing engine and inventory adapters

### The in-process engine needs its environment's tools

**Where.** `jupyterlab_lightcone/projects.py` (`expose_engine_tools`) and
`application.py` (`initialize_settings`). This adapter predates the stack.
The engine resolves executables through `PATH`; a server launched without
activating its environment can miss tools installed beside its interpreter.
The extension appends the interpreter's scripts directory once, preserving
any earlier user-selected executables. The engine's in-process project and
status APIs also remain guarded by the existing `<0.6` dependency cap.

**Upstream and removal.** lightcone-cli should resolve bundled tools from its
interpreter's scripts directory and publish its project/status API. Remove
the `PATH` mutation when tool lookup works without it; relax the version cap
only after validating the documented API. `test_projects.py` verifies lookup
without environment activation, ordering and idempotence.

### Inventory dialogs close before a file tab activates

**Where.** `src/inventory-panel.tsx` (`beforeOpenDocument` supplied to
`useProjectRenderers`). This existing adapter uses React's public `flushSync`
to clear only the inventory's detail state before JupyterLab opens a file tab;
otherwise the dialog's later focus restoration can steal focus from that tab.
ASTRA UI accepts an asynchronous artifact-open callback, but invokes it without
coordinating closure and focus restoration of the controlled detail stack.

**Upstream and removal.** An ASTRA UI callback confirming that the detail dialog
has closed and restored focus would replace the synchronous flush. The CSV, JSON and
SVG artifact-opening cases in `ui-tests/tests/jupyterlab_lightcone.spec.ts`
assert that the inventory dialog closes, the file tab becomes current, and
reopening reuses that tab.

## Validation-only extension isolation

**Where.** `ui-tests/jupyter_server_test_config.py` (temporary LabConfig).
Galata can inherit an optional user-installed `ipyparallel-labextension`
without its matching server extension. Its startup error dialog prevents
Galata's readiness wait, so the test configuration disables that frontend
through JupyterLab's public `disabledExtensions` map. This does not change
installed production configuration or suppress errors from Lightcone itself.

**Removal.** Drop the test-only override when the browser fixture uses an
isolated extension set, or ipyparallel handles an absent backend without a
startup dialog. This is environment isolation, not a production API shim;
the native lifecycle suite exercises readiness with the test configuration.

## Cached papers and astra-tools

**Where.** `jupyterlab_lightcone/routes.py` (`fetch_cached_paper`,
`cached_paper_index`).

**What and why.** Paper lookup and download use astra-tools 0.2.17 in process,
in ASTRA's conventional cache (`PaperCache().cache_dir`). The dependency
promises no stable Python API, so its existing exact pin is retained. It also
documents no exception contract for downloads: any error raised inside
`download_paper_to_cache` (network, provider parsing, a non-PDF body, a cache
write) is reported as an upstream failure, while errors in the extension's own
code remain server errors. The extension still re-indexes the cache for
case-insensitive, containment-checked DOI lookup and restores the case of the
arXiv prefix expected by the downloader.

**Upstream and removal.** A public `PaperCache.find(doi)` with containment checks
and case-insensitive DOI normalization would replace those adapters. A stable
cache/downloader API with documented failures would allow relaxing the exact
dependency pin and the broad download error mapping after tests.

**Coverage.** `test_routes.py` checks cache lookup, invalid DOI input, bounded PDF
streaming, authorization and failed downloads without fetching external papers.
