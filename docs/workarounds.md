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
`useProjectRenderers` and `JupyterOutputProvenance`). This adapter uses React's public `flushSync`
to clear only the inventory's detail state before JupyterLab opens a file tab.
The detail callback delivers the ReactWidget update through Lumino's public
`MessageLoop.sendMessage(this, Widget.Msg.UpdateRequest)` inside that flush.
`Widget.update()` only queues a future render; the dialog's later focus
restoration would then steal focus from the newly opened tab.
ASTRA UI accepts an asynchronous artifact-open callback, but invokes it without
coordinating closure and focus restoration of the controlled detail stack.

**Upstream and removal.** An ASTRA UI callback confirming that the detail dialog
has closed and restored focus would replace the synchronous flush. The CSV, JSON and
SVG artifact-opening cases in `ui-tests/tests/jupyterlab_lightcone.spec.ts`
assert that the inventory dialog closes, the file tab becomes current, and
reopening reuses that tab. `ui-tests/tests/code-link.spec.ts` also checks that
the current source editor receives keyboard focus on first open and reuse,
including the provenance Code tab's separate `Open current file` action.

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

### The persona manager is a subclass, selected while the extension loads

**Where.** `jupyterlab_lightcone/agent_workspace.py` (`PersonaManager`,
`get_chat_dir`, `section_names`, `select_project_persona_manager`) and
`application.py` (`_root_agents_in_projects`).

**What.** Jupyter AI's ACP personas start their agent session in the chat
file's folder. The workbench wants the chat's ASTRA project instead, so it
provides a `PersonaManager` subclass overriding `get_chat_dir()` and sets the
public `PersonaManagerExtension.persona_manager_class` trait to it while the
server extension loads, unless a deployment configured another class. A
failure is logged and leaves Jupyter AI's own manager in place. The subclass
keeps the upstream class name and dedupes `section_names()`.

**Why.** persona-manager 0.2 has no hook for the working directory other than
replacing the manager class. Shipping the trait as static configuration
would mean owning `jupyter_jupyter_ai_persona_manager_config.json`, which
Jupyter AI's extension reads with no `.d` directory to merge into, and would
keep applying after this extension is disabled.
`PersonaManagerExtension._default_persona_id` seeds the picker's default from
the config section named after the class, so a differently named subclass
would silently drop a deployment's `c.PersonaManager.default_persona_id`; two
same-named classes make traitlets merge that section twice, hence
`section_names()`.

**Upstream.** persona-manager: a `chat_dir` hook that needs no subclass (a
configurable callable, or an entry point contributing the manager class), and
`_default_persona_id` resolving the override through
`PersonaManagerClass.section_names()` instead of `__name__`.

**Removal.** Delete the selection and the class-name and `section_names()`
accommodations; keep only what the hook needs.

### The persona id prefix is restated

**Where.** `jupyterlab_lightcone/sessions.py` (`PERSONA_PREFIX`) and
`src/sessions/session-activity.ts` (`PERSONA_USERNAME_PREFIX`).

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

### The server names a chat's project

**Where.** `jupyterlab_lightcone/sessions.py` (`ChatProjectHandler`, the
`api/chat-project` route) and `src/chat-links/chat-project.ts`
(`createChatProjectResolver`).

**What.** The project a chat stored outside every project joined
(`lightcone_project`) lives in the chat document's metadata. The frontend asks
the server, which reads the saved chat through the contents manager and
applies the rule behind the agent's working directory.

**Why.** `IChatModel` exposes no chat-level metadata, and Jupyter Chat's
WebSocket `connection` frame carries none: a browser that opens the chat after
the project was recorded never receives it.

**Upstream.** jupyterlab_chat: chat metadata in the `connection` frame;
`@jupyter/chat`: `readonly metadata` and `metadataChanged` on `IChatModel`.

**Removal.** Resolve from the model's metadata and delete the route.

### Untitled sessions are renamed once they are quiet

**Where.** `src/sessions/session-manager.ts` (`RENAME_QUIET_PERIOD`,
`_nameAfterFirstMessage`).

**What.** A session created untitled is renamed after its first message only
when nobody has been writing, or changing a message, for two seconds, and each
window tries once.

**Why.** Jupyter Chat's WebSocket room saves on every message and learns of a
rename from a Jupyter Events listener that runs a moment later; a streamed
reply saved in between recreates the old file.

**Upstream.** jupyterlab_chat: follow in-band renames before the next save.

**Removal.** Rename as soon as the first message arrives.

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

### Chat files are parsed for session listings and search

**Where.** `jupyterlab_lightcone/sessions.py`.

**What.** Sessions are listed and searched from their `.chat` files, read
through the contents manager and parsed off the event loop with Jupyter
Chat's `Message` and `User` dataclasses, item by item. A summary is reused
while the manager reports the file's modification time and size unchanged.

**Why.** jupyterlab_chat has no read-only loader that needs no room.

**Upstream.** jupyterlab_chat: a tolerant `load_chat(text)`.

### Commands and the factory are named by string

**Where.** `src/workbench-ids.ts` (`CREATE_CHAT_COMMAND`, `CHAT_FACTORY`).

**Upstream.** `@jupyter/chat`: export the `jupyterlab-chat` command ids and
factory name.

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

**Coverage.** Session unit tests cover listing, summaries reused while files are unchanged, malformed documents, hidden files, symlinked project paths, titles, chat projects, quiet and repeated untitled renames, stale listing requests and command availability. Agent workspace tests exercise manager selection, deployment-configured managers, loading without Jupyter AI and project binding without preparing real agents.

## Agent continuity and activity

### Messages naming no installed agent are re-addressed, and comments appended

**Where.** `agent_workspace.py` (`on_chat_message`, `_usual_persona`,
`_deliver`, `_with_comments`) and `agent_defaults.py`.

**What.** Upstream drops a message whose `to_persona` names no installed
persona, and its picker restarts from the server default every time a chat's
view is rebuilt. The override sends such a message to the agent the chat last
addressed, else the one recorded for its project (`.lightcone/agent.json`),
appends selected pending comments to that addressed copy, then calls upstream's
own `on_chat_message`, so upstream still owns processing. The saved chat keeps
the user's text. A deployment using another persona manager receives an explicit
page-config option telling the composer to append the comments visibly instead.

**Why.** persona-manager 0.2 resolves the persona and schedules processing in
one method with no hook between them, and never consults `default_persona`
although its trait help says it does.

**Upstream.** persona-manager: fall back to `self.default_persona` in
`on_chat_message`, and split it into overridable `resolve_persona(message)`
and `prepare_message(persona, message)` hooks.

**Removal.** The override shrinks to the two hooks; `_deliver` disappears.

### The picker's selection is forced through the persona list

**Where.** `src/sessions/persona-registry.ts` (`selectPersona`,
`selectComposerPersona`) and
`src/sessions/agent-continuity.ts` (`whenListed`). The first-message handoff
also selects the chosen agent in the chat picker for subsequent messages.

**What.** To open a chat on its usual agent, the extension publishes a
one-element persona list to `PersonaManagerSessionState.updatePersonas`, then
the full list again: the picker's observed `reconcileSelection` rule selects
a chat's sole persona when the user has not picked one. `whenListed` waits for
the persona to be advertised, following the registry when it discards a chat's
state. Since disposal clears the old state's signals without emitting,
this bounded wait also checks for replacement every 100 ms. Activity follows
the shared persona event stream to reconnect to a replaced state. Restored
views are visited when the optional registry finishes loading.

For initial messages and reopened or moved chat views, a shared handoff retries
this selection until the toolbar
stamps the requested agent (bounded by the composer timeout). The toolbar's
initial metadata stamp can precede its registry subscription, so a single
list update can otherwise be missed during mounting.

**Why.** `@jupyter-ai/persona-manager` 0.2 keeps the selection in React state
with no getter, setter or signal, and `PersonaSessionRegistry.discard` runs
when any one view of a chat closes, so other consumers' state vanishes.

**Upstream.** persona-manager: `selectedPersonaId`, `selectPersona(id)` and a
`selectionChanged` signal on `PersonaManagerSessionState`; reference-counted
registry states per view.

**Removal.** Replace `selectPersona` and the bounded `selectComposerPersona`
handshake with the selection API; `whenListed` drops its re-subscription.

**Reference.** The [upstream selector](https://github.com/jupyter-ai-contrib/jupyter-ai-persona-manager/blob/main/src/persona-controls.tsx)
was checked against persona-manager 0.2.1. The moved-view regression is covered
by `agent-continuity.spec.ts` and the native two-persona browser test.

### The first message validates the picker's stamp and copies its metadata shape

**Where.** `src/sessions/session-manager.ts` (`_sendFirstMessage`,
`_awaitPersonaSelection`), `src/sessions/persona-metadata.ts` (`personaMetadata`)
and `src/sessions/persona-registry.ts`
(`waitForPersonas`).

**What.** The new-session command can send an initial message the way the
composer would: it
waits for the chat's live persona list, validates the chosen agent, runs the
chat command providers, re-stamps the chosen persona in the same shape the
picker uses, then calls `IInputModel.send`. The default persona is read from
the page option persona-manager documents for that purpose, but may initially
name an uninstalled persona before the picker reconciles it with the live list.

**Why.** The picker stamps from a React effect with no signal saying it has
mounted or chosen; `buildMessageMetadata` is not exported from the package
index; `IInputModel.send` does not run the command providers itself.

**Upstream.** persona-manager: export `buildMessageMetadata` and stamp the
selection when the state becomes `ready`; Jupyter Chat: `IInputModel.send`
running `IChatCommandRegistry.onSubmit`.

**Removal.** Delete the wait and the copied shape; call the exported builder.

### Message metadata is read without a published schema

**Where.** `src/sessions/acp-metadata.ts` (readers of `tool_calls[]`,
`permission_status` and `diffs[].path`), used by the session activity markers.

**What.** Activity and edited files come from metadata `jupyter-ai-acp-client`
0.3 writes on messages.

**Why.** The client publishes no schema or types for that metadata.

**Upstream.** jupyter-ai-acp-client: a versioned schema (JSON schema or a small
types package) for the message metadata.

**Removal.** Type the readers against the published schema.

### An optional shared package is imported lazily

**Where.** `src/sessions/agent-continuity.ts`, `src/sessions/index.ts`
(`await import('@jupyter-ai/persona-manager')`).

**Why.** A shared module that is not bundled rejects the whole extension when
absent, and bundling would create a second `Token`.

**Upstream.** JupyterLab builder: `optional: true` in `sharedPackages`.

### Comments and the project agent are stored in a hidden folder

**Where.** `jupyterlab_lightcone/project_store.py`, `agent_defaults.py` and
`comments.py`.

**What.** The last-used persona id is saved atomically in
`<project>/.lightcone/agent.json`; reads are bounded and malformed stores act as
an absent preference. Comments use the same project store boundary, with a
separate atomic `comments.json` file and per-project write locks. A read-only
project still receives its agent response.

**Why.** The engine already ignores `.lightcone/`, but the Contents API refuses hidden paths unless `allow_hidden` is enabled server-wide. The route authorizes the project through its ContentsManager before reading the small preference store from disk.

The private store directory and files cannot be symbolic links. Resolving
the authorized project first still supports a project reached through a link,
without allowing its private store to redirect reads or writes elsewhere.

**Upstream.** lightcone-cli: a visible ignored directory for project preferences.

**Removal.** Store the preference through ordinary Contents paths once the project template offers that directory.

**Coverage.** The routing suite uses a local echo persona, covering absent or stale choices, remembered agents, read-only storage and processing failures. Frontend suites exercise late picker mounting, stale defaults, list disposal, initial-message handoff, activity transitions and multiple views of one chat. The browser continuity test moves a deterministic test persona between the main area and sidebar without contacting a real agent.

## Record navigation

### Middle clicks on ASTRA record links

**Where:** `src/element-widget.tsx` (`RECORD_TRIGGERS`). ASTRA UI's open
callbacks carry no pointer event, and its triggers omit `auxclick`. A scoped
capture handler recognizes only record triggers, forwards middle-click through
the existing click callback, and resets the transient new-tab flag immediately.
Ctrl/Cmd-click uses the same flag. Public `data-slot` hooks are preferred; the
remaining relation/insight/paper BEM class names are enumerated in one constant.

**Remove when:** `@astra-spec/ui` passes the pointer event or a `newTab` flag
to each open callback and handles middle-click. Keep the navigation browser
tests when deleting the handler.

### Embedded ASTRA dialogs rendered as record pages

**Where:** `style/base.css`. The existing embedded dialog has bounded panel
geometry. Record tabs use documented `data-slot`, `data-mode`, and `data-layout`
hooks to make it a scrolling page; output result/provenance, paper artifact,
insight list and decision option parts still require their BEM classes because
those parts expose no slots. These selectors stay scoped to the record body.

**Remove when:** `@astra-spec/ui` offers `layout="page"` for record details.
The narrow/dark record browser test guards the current adaptation.

### Scroll and focus during asynchronous previews

**Where:** `src/versions/scroll-restore.ts`, `focus-restore.ts`, and
`src/element-widget.tsx`. Artifact previews grow after initial render and
expose no load/settled callback. A ResizeObserver reapplies a saved offset
until reached or the reader interacts; its cleanup detaches all listeners.
Focus lost when navigation replaces its control is restored using the public
ReactWidget `renderPromise`, without stealing focus from another widget.

**Remove when:** `@astra-spec/ui` exposes preview `onSettled`; restore once
from that callback. Unit tests cover user interruption, cleanup, and focus
that moves elsewhere while rendering.

### Update dialogs keep their record links unstyled

**Where:** `src/project-notifications.tsx` (`UnstyledBodyRenderer`). JupyterLab's
`Dialog.Renderer.createBody` applies `Styling.styleNode` to every button in a
body, including the review's record links. The public dialog `renderer` option
provides a narrow replacement: a subclass keeps widget and React controls
unstyled, sends the same initial update message, and delegates text bodies to
the stock renderer. Dialog ownership and disposal stay with JupyterLab.

**Remove when:** `@jupyterlab/apputils` offers `styleBody: false`. Tests compare
our controls with the stock renderer and cover widget, React, and text bodies.

### Derived fields are excluded from authored-record comparisons

**Where:** `src/project-changes.ts` (`RESOLVER_KEYS`). ASTRA SDK exposes resolved
record types but no runtime list of derived fields. A mapped type classifies
every key added by the resolver as recursively stripped, stripped only at the
record root, or retained as meaningful state. This makes a new SDK-derived key
fail compilation until reviewed, and prevents globally stripping a key shared
with an authored field. In particular, output artifact metadata is ignored
while an evidence record's authored artifact reference remains comparable.

**Remove when:** `@astra-spec/sdk` exports runtime derived-field metadata per
record kind, or preserves the authored record on each resolved record. Keep
the snapshot tests for metadata-only updates and authored evidence changes.

## Historical output access

### The content route mirrors the Jupyter files security policy

**Where:** `versions.py` (`OutputVersionContentHandler`). Committed SVG/PDF
bytes can be active documents. Jupyter Server's FilesHandler hard-codes its
CSP sandbox and same-site XSRF check without an extractable public mixin. This
authenticated, contents-authorized route therefore applies the same sandbox
and `check_xsrf_cookie()` policy, streams bounded content off the event loop,
and never caches error responses as immutable content. Tests exercise both
read authorization and cross-site inclusion.

**Remove when:** Jupyter Server exposes its files security policy as a public
mixin; use it while retaining the adversarial route tests.

### Engine output locations are not a public discovery API

**Where:** `versions.py`, `results.py`, and `provenance.py`. The pinned
lightcone-cli engine's `plan.build()` supplies the declared output location.
For an output no longer declared, a bounded repository lookup uses the engine's
results layout. Hidden manifest sidecars are read after authorizing their
containing visible directory through the contents manager, and their schema
and output identity are validated before exposing data. Git history and rename
tracking use dulwich; git-annex keys and bytes use documented JSON commands.

**Remove when:** lightcone-cli publishes output paths and manifest data through
a stable read-only API (or `lc status --json`); remove the layout fallback and
hidden-file reads. Until then the existing engine minor-version cap guards the
in-process API. Tests cover renamed/deleted outputs, nested projects, manifest
validation, and containment.

### Avoid initializing a git-annex clone while reading it

**Where:** `versions.py` (`Repository.annex_state`) and `annex.py`. Even a
lookup can initialize an annex clone. A repository with a `*/git-annex` ref
and no local `annex.uuid` is reported as uninitialized without invoking any
annex command. Otherwise lookupkey/examinekey/whereis/contentlocation use their
documented JSON or path outputs; no annex pointer or object layout is decoded.
The executable is resolved beside this interpreter before PATH, because the
git-annex wheel installs it there. Tests verify clone reads make no changes.

**Remove when:** git-annex provides a guaranteed non-initializing state query.
The engine's own executable lookup should also search its interpreter's scripts
directory so installations launched without an activated shell remain usable.

## Provenance inspection

### Hidden-file policy for a historical source path

**Where:** `versions.py` (`validate_source_path`). ContentsManager.is_hidden
requires a file on disk, while a historical blob may no longer exist there.
The route validates the project-relative path and applies the dot-segment
rule by name, honoring the server's `allow_hidden` setting. Authentication,
contents authorization and project containment remain enforced. Tests reject
absolute/traversing paths and hidden components before querying a blob.

**Remove when:** jupyter_core publishes a name-only hidden-path predicate;
replace the local rule while keeping the authorization and path tests.

### A run is described by the engine manifest

**Where:** `src/versions/provenance-tabs.tsx`, `version-model.ts`, and the
version routes. The engine's materialization commits include DataLad run
records, but its public status response does not expose a structured complete
run. The UI shows only validated manifest facts and commit metadata; it does
not infer an exit status or command from commit prose. The existing engine
version cap guards the manifest schema consumed in process.

**Remove when:** lightcone-cli publishes structured run records, including
command and exit status, or `lc log --json`. Use that source without parsing
commit subjects. The selected-version provenance tests must still prevent
current-sidecar facts being attributed to older runs.

## Artifact comparisons

The comparison uses the existing authenticated historical-content API and
ASTRA's public preview components; it introduces no new engine or Git protocol.
One additional layout adaptation remains: `style/versions.css` scopes a rule to
`.astra-figure-zoom` containing `VersionCompare`, leaving room for the figure's
zoom buttons. ASTRA UI exposes no slot for that frame. Remove this selector
when a public figure-frame slot or page-layout API supplies the same spacing;
`src/versions/__tests__/components.spec.tsx` covers image availability, swipe
and blink controls. `ui-tests/tests/output-versions.spec.ts` checks a comparison
whose two table revisions use different formats. These behavior tests do not
assert the figure-frame spacing.

## Chat cards, links and reply results

### Reply links and images need a DOM adapter

**Where:** `src/chat-links/link-fixer.ts`, `chat-paths.ts`, and `chat-dom.ts`.
Jupyter Chat renders Markdown with the application registry but exposes no
per-message URL resolver or link handler. A scoped capture listener opens
server-local links with `IDocumentManager`; a `MutationObserver` rewrites local
image sources to Jupyter's authenticated files route. Only rendered message
bodies are touched. The module-private `RENDERED_CLASS` from
`components/messages/message-renderer` is restated once. The panel's disposal
removes the listener and observer, and pending work checks disposal.

**Remove when:** `@jupyter/chat` exposes RenderMime `resolver`/`linkHandler`
options or a registry for them. Retain the path-containment, URL and disposal
tests while replacing the DOM adapter with those public hooks.

### The absolute contents root is published

**Where:** `jupyterlab_lightcone/application.py` (`_publish_server_root`) and
`src/chat-links/chat-paths.ts` (`serverRoots`). JupyterLab's `serverRoot` page
option abbreviates the home directory as `~`, so it cannot match the absolute
paths agents write. The extension publishes the local contents root, when
available; jupyter-lsp's `rootUri` can supply the resolved spelling as well.
Nonlocal contents managers publish nothing.

**Remove when:** `jupyterlab_server` exposes an absolute server-root page option.
Use that option and remove the custom publication and its server tests.

### Agent preview tools repeat the originating-persona lookup

**Where:** `jupyterlab_lightcone/agent_tools.py` (`_origin_manager`,
`_origin_persona`). The MCP routing middleware exposes the originating browser
id but not the persona. The tools repeat its header-to-registry lookup and
check that the persona's processing message names that same browser and its chat id matches
the request header. The
persona's own chat model publishes the card under the agent's identity. No
browser id means no command execution; tools never broadcast.

**Remove when:** `jupyter-server-mcp` exposes a per-call `calling_persona`
context alongside the client id, and injects the server/settings handle into
tools. Keep the wrong-browser and absent-persona regressions.

### Jupyter's MCP server is given instructions for the preview tools

**Where:** `jupyterlab_lightcone/agent_tools.py` (`SERVER_INSTRUCTIONS`,
`add_server_instructions`) and `application.py`
(`_start_jupyter_server_extension`). Agents that load MCP tools on demand, as
Claude Code does beside many other servers, list only the tools' names until
they search for one, so the tool descriptions go unread when an agent decides
how to answer. MCP server instructions reach the agent up front. Jupyter AI
connects its agents to the `jupyter-server-mcp` server, which creates its
`FastMCP` instance with a name only and has no setting or entry point for
instructions. The extension therefore appends a paragraph to the running
instance's public `FastMCP.instructions` property, keeping text another
package set, and adds it once. The MCP extension creates that instance in its
own start hook, and Jupyter Server starts extensions concurrently, so
Lightcone's start hook yields once before looking for it. Agents connect only
when a chat opens, after both have started. Without a running MCP server the
agents get no instructions, and the server log says so. Coverage:
`tests/test_agent_instructions.py`, including a connecting client that reads
the instructions and an MCP server started after Lightcone.

**Remove when:** `jupyter-server-mcp` accepts instructions, as an
`MCPExtensionApp` setting beside `mcp_name` or, better for a shared server,
from each tools entry point alongside its tools. Ship the paragraph through
that hook and delete `add_server_instructions` and the start hook; keep the
connecting-client test.

### Command timeouts have no structured error code

**Where:** `agent_tools.py` (`_command`). The command toolkit returns a timeout
as error text. A narrow check for "timed out" supplies recovery guidance to the
agent; other errors preserve the upstream result.

**Remove when:** `jupyterlab-commands-toolkit` includes a stable timeout code.

### Saved MIME records need explicit hydration for deduplication

**Where:** `agent_tools.py` (`lightcone_preview_element`). Jupyter Chat's `Message(**dict)`
leaves its nested `mime_model` as a dict when loading a saved conversation. The
preview tool constructs the exported `MimeModel` before comparing the card and
prompt metadata, so a retry after reload does not insert a duplicate card.

**Remove when:** `jupyterlab_chat.Message` hydrates nested MIME models on load.

### MIME renderer disposal uses a custom element

**Where:** `src/astra-mime.tsx` (`AstraCardElement`, `AstraMimeRenderer`).
Jupyter Chat 0.25 inserts the renderer's node without disposing its widget.
Connection callbacks own the React root so closing a chat or removing a message
releases project leases and historical-preview effects. The scoped
`.jp-chat-rendered-message.jp-OutputArea` rule in `style/base.css` also removes
that wrapper's clipping around ASTRA cards.

**Remove when:** `@jupyter/chat` disposes RenderMime widgets on rerender/removal
and offers a documented wrapper style hook. Replace the custom element with a
normal widget-owned root and remove the wrapper selector.

### Reply results observe in-place message updates

**Where:** `src/chat-links/turn-results-footer.tsx`. Jupyter Chat mutates
`IChatModel.messages` in place; message/state signals advance a revision used
by React memos so streamed messages are not missed. Engine results have no
chat/turn id, so the footer correlates bounded Git result commits with server
message timestamps and refreshes once the reply settles. The existing guarded
ACP metadata readers provide edited paths; no additional schema is invented.

**Remove when:** Chat exposes immutable message snapshots or a revision field,
and Lightcone commits expose a producing turn id. Use those identities and
remove timestamp matching; retain cache and streamed-turn regressions. Until
then the label says **Results updated**, since manual result commits also
qualify. Tiles read and open the recorded commit; an unavailable historical
thumbnail falls back to its output-kind label, never to current file bytes.

### The card contract is validated on both sides

**Where:** `agent_tools.py` and `src/astra-mime-data.ts`. The MIME type and small
versioned payload are necessarily spelled in Python and TypeScript. Both
validate the optional output commit/key; the browser uses the existing history
commit predicate and never evaluates executable card contents.

**Remove when:** a shared published schema/code generator owns the card
contract. Keep malformed-payload tests in both runtimes.

### Authored ASTRA paths still need the vendored MySTRA grammar

**Where:** `src/vendor/mystra-path.ts`, the path-only subset of MySTRA revision
`8b7dd797`, with its adjacent license. The ASTRA SDK exposes canonical indexes
but no parser for authored shorthand or option/evidence paths. Record commands
and chat card references use one existing grammar; this layer only replaces
unchecked collection casts with type guards and removes a non-null assertion.

**Remove when:** `@astra-spec/sdk` exports a browser-safe `parseAstraPath`, its
`AstraPath` type, and a canonical record path resolver.
Retain the record-reference resolution tests when replacing the vendored file.

## Project Home

### Home discovers personas through an in-memory manager

**Where.** `jupyterlab_lightcone/project_agents.py` (`available_agents`) and
`src/home/home-view.tsx` (`useProjectAgents`). `src/home/personas.ts`
(`PersonaDirectory`) watches live list changes to refresh the discovery.

**What.** The project-authorized route creates a temporary manager with an
in-memory chat to discover installed and project-local personas. It neither
saves the chat nor calls agent preparation, sends messages or attaches an event
logger. Discovery imports project-local Python, so the route requires
`execute` on `lightcone` as well as `read` on `contents` before constructing
the manager. Live persona events invalidate discovery, including removals,
without maintaining a second merged catalog. It releases the temporary
document afterwards. It must not shut down
unprepared personas: ACP's shutdown touches class-shared clients belonging to
other chats. The launcher displays this project's choices before any chat opens.

**Why.** persona-manager 0.2 advertises personas only once a chat is open;
there is no chat-independent listing.

**Upstream.** persona-manager: project-scoped discovery returning ids, names and
a valid default without constructing a manager or persona instances.

**Removal.** Replace the temporary manager and custom route with that API.

### Home reuses the chat picker's building blocks and styles

**Where.** `src/home/agent-picker.tsx` (`AgentPicker`) and
`jupyterlab_lightcone/project_agents.py` (`persona_avatar`).

**What.** The launcher uses Jupyter Chat's exported `JlThemeProvider`, the same
MUI button/menu/icon components as Jupyter AI, and Jupyter AI's existing
`jp-jai-personaControls` and `jp-jai-controlMenu` styles. Small avatar assets
are included in discovery because the upstream avatar route's cache is only
populated after a real chat opens.

**Why.** Jupyter AI's selector is embedded in `PersonaControls`, with state
owned by a chat model; no standalone controlled picker is exported.

**Upstream.** Export a picker taking persona options, a selected id and an
`onSelect` callback, plus chat-independent avatar discovery.

**Removal.** Replace `AgentPicker` with that shared component and drop avatar
inlining when discovery supplies usable image URLs.

### Enter inserts paragraphs in the description dialog

**Where.** `src/project-description.ts` (`DescriptionDialog._evtKeydown`).

**Why.** JupyterLab's dialog cancels the default Enter behavior even when a
textarea is focused. The subclass leaves Enter's native behavior intact in
the description field and delegates other keys to the standard dialog.

**Upstream.** `@jupyterlab/apputils`: skip `preventDefault()` for Enter in a
textarea.

**Removal.** Use `Dialog` directly and delete the subclass.

### The launcher plugin is replaced

**Where.** `package.json` (`disabledExtensions`), `src/home/index.ts`,
`schema/home.json`.

**What.** Inside a project the launcher tab shows Home. The stock launcher
plugin is disabled and its `activate`, `launcher:create` command, menu,
shortcut and toolbar entries are mirrored (JupyterLab 4.6.3) so every entry
point keeps working; the plugin id carries the npm name because settings
schemas load only under a registered plugin id.

**Why.** `ILauncher` offers only `add()`; nothing lets a plugin provide the
tab's body.

**Upstream.** `@jupyterlab/launcher-extension`: a body-provider token consulted
by `launcher:create`, or the `ILauncher` provider split from the command.

**Removal.** Re-enable the stock plugin; provide the body.

### Hidden project listings are refreshed by re-sorting

**Where.** `src/project-browser.ts` (`ProjectFileBrowser.refreshMarkers`).
`DirListing` skips rebuilding its items while hidden, including before the
project-picker dialog attaches. Updating badge metadata and calling `update()`
would leave the initial folder empty. The subclass reapplies the current public
sort state to rebuild items without changing the user's ordering; it does not
access the listing's private item cache.

**Upstream and removal.** `@jupyterlab/filebrowser` should rebuild on attach or
expose `refreshItems()`. Replace the re-sort with that hook.
`src/__tests__/project-browser.spec.ts` checks that the starting directory's
items and project labels appear before any navigation.

### Home freshness borrows a results-commit timestamp

**Where.** `src/home/home-view.tsx` (`useLatestResultsTime`) and `home-model.ts`
(`summarizeFreshness`). The engine's output status has no materialization time,
so Home asks the existing results-history API for the newest results commit
and uses its timestamp. Remote drives omit this optional time; unavailable
history clears it, and effects discard stale responses after the view changes.
The freshness line labels this "results updated": the newest retained result
commit can include manual edits or concurrent changes and is not proof that
the engine ran.

**Upstream and removal.** lightcone-cli should expose an ISO 8601 materialization
time associated with its output commit, or structured run records. Use that
field and remove Home's extra history request. `home-desk.spec.ts` checks the
freshness line from a controlled results timestamp; backend history tests
validate the bounded result-commit listing.

### The isolation reset forces host controls into a layer

**Where.** `style/home.css` and `style/comments.css`, with the layer order
declared in `style/base.css`.

**Why.** `isolate.css` resets everything inside an `astra-isolate` root with
`all: revert-layer`, so host controls placed inside must live in a layer
ordered after ASTRA's; the layer names are restated because CSS cannot order a
layer after another stylesheet's layers without naming them.

**Upstream.** `@astra-spec/ui`: document the layer order, or scope the reset
to its own parts.

**Removal.** Use the documented ASTRA layer order or scoped reset, then delete
Home's copied layer-order assumptions while retaining its preview controls.

**Coverage for Home's adapters.** `test_project_agents.py` verifies that listing
personas never prepares or shuts down agents, creates no chat, and selects
only an available default. `src/home/__tests__/home-plugin.spec.ts` covers the
launcher replacement's entry points, restoration, stock-plugin exclusion and
per-tab switching. `home-desk.spec.ts` covers discovery and the first-message
handoff, while `ui-tests/tests/launcher-agents.spec.ts` verifies the native
picker. `project-description.spec.ts` exercises Enter paragraphs and preserved
Markdown in the real dialog; the native Home plate/theme case covers the
preview controls inside ASTRA isolation.

## Project navigation

### Colliding tab labels need a secondary label

**Where.** `src/tab-labels/`, `style/tab-labels.css`; session titles continue
using the earlier session-title workaround.

**What and why.** Lumino exposes no secondary tab label, and changing a
`DocumentWidget` title would rename its file. The extension keeps each title's
label intact and places the colliding project's folder in public
`Title.dataset`, using its full project path when folder names also collide.
Namespaced CSS renders that secondary text.

**Upstream and removal.** A rendered `Title.sublabel` on Lumino's default tab
renderer would replace the dataset/CSS label.

### Project and session changes require polling

**Where.** `src/sidebar/sidebar-model.ts` (`CoalescingRunner`),
`src/project-data-service.ts`, `src/materialization-status.ts`.

**What and why.** Writes by agents, Git and the Lightcone engine do not emit
`Contents.IManager.fileChanged`. The sidebar polls visible project data,
materialization states and session listings; local Contents changes refresh
it promptly. `CoalescingRunner` retains one requested refresh while work runs
because `Poll.refresh()` cancels a refresh requested during an active tick.

**Upstream and removal.** Jupyter Server filesystem Contents events and a
Lumino queued-refresh option would replace polling and the small runner.
The engine can also expose a status revision or change event to avoid polling
`lc status`.

**Coverage.** `src/tab-labels/__tests__/tab-labels.spec.ts` verifies collision
labels appear and disappear without changing the title's label, and
`ui-tests/tests/workbench-features.spec.ts` checks two projects in the native
tab bar. `src/sidebar/__tests__/sidebar-model.spec.ts` covers hidden/disposed
polling, stale project responses and refresh requests arriving during a run;
`src/__tests__/project-data-service.spec.ts` covers shared leases and refreshes.

## Pipeline integration

The pipeline adds no independent package workaround. It reuses
`useMaterializationStatus` from `src/materialization-status.ts`, including
the existing filesystem/status polling described under Project navigation.
The graph reads resolved ASTRA input/output relationships through SDK types;
its SVG and its Lumino placement/restoration use supported public APIs.
A server/engine status-change event would remove polling from this consumer
alongside Home, the sidebar and record tabs.

## Figure and text comments

### The comment tray is inserted before the input

**Where.** `src/comments/comment-tray.tsx` (`TrayMount.place`).

**What.** Pending comments show as chips above a session's composer. The tray
is a React root placed before the chat's input container and put back
whenever the chat re-renders around it.

**Why.** Jupyter Chat has no slot between the messages and the input; the
input toolbar registry renders inside the toolbar row.

**Upstream.** `@jupyter/chat`: an input-header registry mirroring
`IMessagePreambleRegistry`, or at least an exported input-container class.

**Removal.** Register the tray; delete the placement and the observer.

### Chip clicks stop propagation

**Where.** `src/comments/comment-tray.tsx` (the chip click handler).

**What.** The handler stops the click from bubbling after opening the pinned
figure or its image file.

**Why.** Jupyter Chat 0.25's `ChatWidget` refocuses its input for every click
inside its node. A chip opens another document, whose focus would immediately
be taken back by the chat.

**Upstream.** `@jupyter/chat`: skip input refocusing when a click originated
from an interactive element or its handler already moved focus.

**Removal.** Delete the chip's `stopPropagation()` once upstream respects the
focused document; keep the ordinary command-driven target opening.

### Commentable figures are found by a BEM class

**Where.** `src/comments/comment-hosts.ts` (`ElementHost`),
`style/comments.css`.

**What.** The record host finds the output image under
`.astra-output-detail__artifact` and places the comment layer beside it.

**Why.** `@astra-spec/ui` 0.0.7 exposes no annotation host or stable `data-slot`
on this figure. Re-rendering remains owned by ASTRA UI; the extension only
observes the image and owns its separate layer.

**Upstream.** `@astra-spec/ui`: expose a documented figure `data-slot` or an
annotation-host callback.

**Removal.** Replace the BEM selector with the public host hook and remove the
matching selector-dependent CSS when the hook ships.

### Pins and highlights are measured overlays

**Where.** `src/comments/image-layer.ts`, `text-layer.ts`, `comment-layer.ts`.

**What.** Independently owned DOM layers position image pins from percentage
coordinates and text highlights/badges from selection bounds. They observe
resizes, content changes and scrolling, and disconnect their observers and
event listeners on disposal. CodeMirror decorations use its public extension
API; only rendered previews need these measured overlays.

**Why.** Neither `@astra-spec/ui` 0.0.7 nor JupyterLab's image and Markdown
viewers expose annotation slots. Their React and PDF.js renderers own the
content, so the extension measures the visible image or quote without taking
over rendering.

**Upstream.** `@astra-spec/ui`, `@jupyterlab/imageviewer` and
`@jupyterlab/markdownviewer`: annotation slots with coordinate conversion and
notifications when figure, text or page bounds change.

**Removal.** Render through those slots and delete measured positioning,
mutation observers and manual layer reattachment for the supported hosts.

### Messages are found by their index attribute

**Where.** `src/comments/comment-hosts.ts` (`SessionHost.targetFor`,
`CommentHosts.resolveSelection`).

**What.** A selected transcript quote is mapped to a message by the exported
message-container selector and its `data-index`; the corresponding model
message supplies the persistent message ID stored with the comment.

**Why.** Jupyter Chat 0.25 exports the container class but its rendered DOM
identifies messages only by array index, while comments need a stable ID.
Selections inside the composer are excluded from transcript commenting.

**Upstream.** `@jupyter/chat`: expose `data-message-id` on the rendered message
container, or a public element-to-message resolver.

**Removal.** Read the stable ID directly and delete the index-to-model lookup.

### Paper pages are found by `data-page`

**Where.** `src/comments/selection-button.ts` and `text-layer.ts`, using
`PAGE_ATTRIBUTE` from `comment-model.ts`.

**What.** Paper selections and restored quote highlights find their 1-based
page number from ASTRA UI's existing `data-page` attribute.

**Why.** `@astra-spec/ui` 0.0.7 uses that attribute for its own page navigation,
but exposes no documented annotation API to identify the page of a selection.

**Upstream.** `@astra-spec/ui`: document and export the page attribute contract,
or expose a page lookup through its annotation host API.

**Removal.** Use the exported page lookup or attribute constant, removing the
locally restated name and direct ancestry lookup when an API replaces it.

## Search and composer references

### Search sections follow the command palette's category ordering

**Where.** `src/search/search-palette.ts` (`sectionCategory`, `formatHeader`).
The public Lumino `CommandPalette` sorts equally matched items by category
text before rank and offers no category comparator. Categories carry circled
digits to preserve the intended sessions, records, files, and commands order;
the renderer removes those prefixes from visible headings. Native matching,
keyboard navigation, and command execution remain with the palette.

**Upstream / removal.** A category rank or `compareCategories` option in
`@lumino/widgets` would replace both prefixing and heading cleanup. Keep the
section-order and keyboard tests when removing this adaptation.

## Lightcone themes

### Two registered themes share one built stylesheet

**Where.** `src/theme/index.ts`, `style/themes/index.css`, and `package.json`
(`jupyterlab.themePath`). The JupyterLab builder accepts one theme entry per
package. Both public `IThemeManager` registrations load that same built CSS;
the palette selectors use JupyterLab's `data-jp-theme-name` attribute to choose
light or dark colors. Loading a theme neither chooses it for the user nor
changes the standard theme's palette.

**Upstream / removal.** Multiple theme entries per package in `@jupyter/builder`
would allow separate light and dark CSS assets. Split the entry and load URLs,
remove the combined selector arrangement, and retain theme-registration, palette
contrast, and theme-switching tests. Focus Layout uses public shell methods
and the existing status-bar command and needs no compatibility workaround.
