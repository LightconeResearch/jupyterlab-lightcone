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

**Rebuilds.** A running `myst start` keeps serving after its `_build/site` or
downloaded `_build/templates` folder is deleted, but only 404s, and does not
rebuild them. The supervisor restarts it in place when a folder it has seen
disappears; the session's `launch` count tells the viewer tab to reload the
report at its unchanged URL.

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

## Project sessions and binding

### The persona manager is a subclass, installed through Jupyter AI's config file

**Where.** `jupyterlab_lightcone/agent_workspace.py` (`PersonaManager`,
`get_chat_dir`, `section_names`) and
`jupyter-config/persona-manager/jupyter_jupyter_ai_persona_manager_config.json`,
installed as `etc/jupyter/jupyter_jupyter_ai_persona_manager_config.json`.

**What.** Jupyter AI's ACP personas start their agent session in the chat
file's folder. The workbench wants the chat's ASTRA project instead, so it
ships a `PersonaManager` subclass overriding `get_chat_dir()` and selects it
through the public `PersonaManagerExtension.persona_manager_class` trait, in
the configuration file Jupyter Server reads for that extension. The subclass
keeps the upstream class name and dedupes `section_names()`.

**Why.** persona-manager 0.2 has no hook for the working directory other than
replacing the manager class. `PersonaManagerExtension._default_persona_id`
seeds the picker's default from the config section named after the class, so
a differently named subclass would silently drop a deployment's
`c.PersonaManager.default_persona_id`; two same-named classes make traitlets
merge that section twice, hence `section_names()`.

**Upstream.** persona-manager: a `chat_dir` hook that needs no subclass (a
configurable callable, or an entry point contributing the manager class), and
`_default_persona_id` resolving the override through
`PersonaManagerClass.section_names()` instead of `__name__`.

**Removal.** Delete the config file, the `pyproject.toml` shared-data line and
the class-name and `section_names()` accommodations; keep only what the hook
needs.

### The persona id prefix is restated

**Where.** `jupyterlab_lightcone/sessions.py` (`PERSONA_PREFIX`) and
`src/sessions/session-user.ts` (`PERSONA_USERNAME_PREFIX`).

**What.** Persona senders are told from people by the documented
`jupyter-ai-personas::` prefix of `BasePersona.id`, spelled once per language.

**Why.** Neither package exports the prefix or a predicate (`is_persona` is a
module function that `__init__` does not re-export).

**Upstream.** persona-manager: export `PERSONA_ID_PREFIX` and `is_persona`
from the Python and TypeScript package roots.

**Removal.** Import them.

### The browser reports the current project before the chat opens

**Where.** `src/current-project.ts` (the `PUT api/current-project` report on
change and on window focus), `jupyterlab_lightcone/project_routes.py`
(`CurrentProjectHandler`), `projects.py` (`join_project`).

**What.** Jupyter AI creates the agent session as soon as a chat opens, before
any message could carry context, and a chat created from Jupyter Chat's own
entry points may sit outside every project. The server therefore keeps the
project the browser last reported as current, joins chats to it on first
opening and records the choice in the chat's metadata.

**Why.** Jupyter Chat's create command accepts no initial metadata and
persona-manager decides the working directory eagerly.

**Upstream.** Jupyter Chat: `jupyterlab-chat:create` accepting initial
metadata; persona-manager: resolving the working directory on the first
message, or from chat metadata.

**Removal.** Delete the route, the report and the server-side setting; the
frontend writes the project into the chat at creation.

### Chat-level metadata is read from the shared document

**Where.** `src/chat-links/chat-project.ts` (`recordedChatProject`).

**What.** The project a chat joined (`lightcone_project`) lives in the chat
document's metadata, which the frontend reads from the `sharedModel` behind
`IChatModel`, checked by shape.

**Why.** `IChatModel` exposes no chat-level metadata; the `jupyterlab-chat`
model that holds it is not a dependency here.

**Upstream.** `@jupyter/chat`: `readonly metadata` and `metadataChanged` on
`IChatModel`; jupyterlab-chat: `YChat.getMetadata()`.

**Removal.** Read the model's metadata.

### Session tabs show their title through CSS

**Where.** `src/sessions/session-manager.ts` (`syncSessionTabTitle`) and
`style/sessions.css`.

**What.** The first human message supplies a tab title through the public
`Title.dataset`, rendered by `::before`; the document label stays the filename.
The active tab retains its top border through JupyterLab's private CSS variable.

**Why.** `DocumentWidget` renames its file whenever `title.label` changes, so
setting a descriptive title would rename every reopened session.

**Upstream.** `@jupyterlab/docregistry`: an opt-out of rename-on-label.

**Removal.** Set the ordinary label and remove the dataset and CSS rules.

### Session listings are polled

**Where.** `src/sessions/session-manager.ts` (`POLL_INTERVAL`).

**Why.** Jupyter Chat's WebSocket transport writes chat files directly, so
neither `contents_service` events nor `Contents.IManager.fileChanged` fire.

**Upstream.** jupyterlab_chat: a `message` Jupyter Event, or saving through
the contents manager.

### Chat files are parsed for session listings

**Where.** `jupyterlab_lightcone/sessions.py`.

**What.** Sessions are listed from their `.chat` files, read
through the contents manager and parsed with Jupyter Chat's `Message` and
`User` dataclasses, item by item.

**Why.** jupyterlab_chat has no read-only loader that needs no room.

**Upstream.** jupyterlab_chat: a tolerant `load_chat(text)`.

### Commands and the factory are named by string

**Where.** `src/workbench-ids.ts` (`CREATE_CHAT_COMMAND`, `CHAT_FACTORY`).

**Upstream.** `@jupyter/chat`: export the `jupyterlab-chat` command ids and
factory name.

### The sessions route is not `api/sessions`

**Where.** `sessions.py` (`setup_session_handlers`).

**Why.** Galata's `Routes.sessions` regex is unanchored and would mock any URL
containing `/api/sessions` in the UI tests.

**Upstream.** `@jupyterlab/galata`: anchor the runner routes to the base URL.

### Focus returns to a session on a timer

**Where.** `src/sessions/session-manager.ts` (`_onCurrentChanged`).

**Why.** `ILabShell.currentChanged` fires from the closing widget's `disposed`
signal, before the dock has switched tabs.

**Upstream.** `@jupyterlab/application`: a post-layout signal.

### Ignore `chats/` and `*.chat` in the project template

Sessions are Jupyter Chat documents under `<project>/chats/`. `lc materialize`
refuses to start on a dirty tree, and the extension never writes to `.git` or
`.gitignore`. The required lightcone-cli 0.5.0rc3 or newer template ignores
`chats/` and `*.chat` when initializing a project. Existing projects must also
ignore chat documents before materialization; this extension does not change
their Git configuration.

**Coverage.** Session unit tests cover listing, malformed documents, hidden files, symlinked project paths, titles, repeated untitled renames, and command availability. Agent workspace tests exercise the shipped configuration and project binding without preparing real agents.
