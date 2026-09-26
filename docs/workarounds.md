# Workarounds around other packages

What the workbench does to get around a limitation, a private API or a missing
hook of a package it builds on, and the narrow change in that package that
would let the workbench delete the workaround. Nothing here can be changed in
another project right now; this list exists so that each item can become a
small, well-scoped upstream proposal later.

Each entry says **where** the code is (by module and symbol, so line numbers
do not matter), **what** it does, **why** the package leaves no better way,
the **upstream** change that would remove it, and the **removal** here once
that change ships. The versions named are the ones the extension is pinned to:
JupyterLab 4.6, Jupyter AI 3.2 with persona manager 0.2 and ACP client 0.3,
jupyter-server-mcp 0.3, Jupyter Chat 0.25, `@astra-spec/ui` 0.0.7,
`@astra-spec/sdk` 0.1.2, lightcone-cli 0.5, git-annex 10.2026.

The MySTRA viewer is a separate, documented stopgap; see the top of
[`AGENTS.md`](../AGENTS.md). Add an entry here whenever a new workaround is
unavoidable, and delete the entry with the code.

## Jupyter AI persona manager

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

### Messages naming no installed agent are re-addressed, and comments appended

**Where.** `agent_workspace.py` (`on_chat_message`, `_usual_persona`,
`_deliver`, `_with_comments`) and `agent_defaults.py`.

**What.** Upstream drops a message whose `to_persona` names no installed
persona, and its picker restarts from the server default every time a chat's
view is rebuilt. The override sends such a message to the agent the chat last
addressed, else the one recorded for its project (`.lightcone/agent.json`),
appends the pending comments to the copy handed to the persona, then calls
upstream's own `on_chat_message` with that copy, so upstream still does the
processing.

**Why.** persona-manager 0.2 resolves the persona and schedules processing in
one method with no hook between them, and never consults `default_persona`
although its trait help says it does.

**Upstream.** persona-manager: fall back to `self.default_persona` in
`on_chat_message`, and split it into overridable `resolve_persona(message)`
and `prepare_message(persona, message)` hooks.

**Removal.** The override shrinks to the two hooks; `_deliver` disappears.

### The picker's selection is forced through the persona list

**Where.** `src/sessions/persona-registry.ts` (`selectPersona`) and
`src/sessions/agent-continuity.ts` (`whenListed`). Home's first-message handoff
also selects the chosen agent in the chat picker for subsequent messages.

**What.** To open a chat on its usual agent, the extension publishes a
one-element persona list to `PersonaManagerSessionState.updatePersonas`, then
the full list again: the picker's documented `reconcileSelection` rule selects
a chat's sole persona when the user has not picked one. `whenListed` waits for
the persona to be advertised, following the registry when it discards a chat's
state.

For Home's first message, the handoff retries this selection until the toolbar
stamps the requested agent (bounded by the composer timeout). The toolbar's
initial metadata stamp can precede its registry subscription, so a single
list update can otherwise be missed during mounting.

**Why.** `@jupyter-ai/persona-manager` 0.2 keeps the selection in React state
with no getter, setter or signal, and `PersonaSessionRegistry.discard` runs
when any one view of a chat closes, so other consumers' state vanishes.

**Upstream.** persona-manager: `selectedPersonaId`, `selectPersona(id)` and a
`selectionChanged` signal on `PersonaManagerSessionState`; reference-counted
registry states per view.

**Removal.** `selectPersona` becomes one call; `whenListed` drops the
re-subscription.

### The first message validates the picker's stamp and copies its metadata shape

**Where.** `src/sessions/session-manager.ts` (`_sendFirstMessage`,
`_awaitPersonaSelection`, `personaMetadata`) and `src/sessions/persona-registry.ts`
(`waitForPersonas`).

**What.** Home's **Start** sends a message the way the composer would: it
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

### Home discovers personas through an in-memory manager

**Where.** `jupyterlab_lightcone/project_agents.py` (`available_agents`) and
`src/home/home-view.tsx` (`useProjectAgents`). `src/home/personas.ts`
(`PersonaDirectory`) watches live list changes to refresh the discovery.

**What.** The project-authorized route creates a temporary manager with an
in-memory chat to discover installed and project-local personas. It neither
saves the chat nor calls agent preparation, sends messages or attaches an event
logger. It releases the temporary document afterwards. It must not shut down
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

## Jupyter AI ACP client

### Message metadata is read without a published schema

**Where.** `src/sessions/acp-metadata.ts` (readers of `tool_calls[]`,
`permission_status`, `diffs[].path`, `acp_config_options`, `acp_modes` and
the `__mode__` option id), used by the session activity markers, the **Files
edited** footer and the permission mode in a session's toolbar.

**What.** Activity, edited files and the agent's permission mode come from
metadata `jupyter-ai-acp-client` 0.3 writes on messages and on the chat.

**Why.** The client publishes no schema or types for that metadata.

**Upstream.** jupyter-ai-acp-client: a versioned schema (JSON schema or a small
types package) for the message and chat metadata, and a documented id for the
mode option.

**Removal.** Type the readers against the published schema.

## jupyter-server-mcp and jupyterlab-commands-toolkit

### The calling persona is resolved again for the preview tool

**Where.** `jupyterlab_lightcone/agent_tools.py` (`_origin_manager`,
`_origin_persona`, `_settings`).

**What.** The tools find the calling chat's manager and persona from the
request headers jupyter-server-mcp documents, through the manager registry in
the server settings, reading the server through `ServerApp.instance()`; the
routing middleware makes the same walk but publishes only the browser id.

**Why.** Tools are loaded as bare callables with no server handle, and no
public accessor exposes the calling persona.

**Upstream.** jupyter-server-mcp: bind a `calling_persona` context variable
beside `target_client_id`, and pass a context object to tools.

**Removal.** Read the persona from the context variable; drop `_settings`.

### A command timeout is detected from the error text

**Where.** `agent_tools.py` (`_command`).

**What.** A browser command that timed out is reported as unconfirmed, by
matching "timed out" in the toolkit's error string.

**Why.** `execute_command` returns one free-text error for every failure.

**Upstream.** jupyterlab-commands-toolkit: a structured error code.

**Removal.** Compare the code.

## Jupyter Chat

### Chat-level metadata is read from the shared document

**Where.** `src/chat-links/chat-project.ts` (`recordedChatProject`) and
`src/sessions/session-permissions.ts`.

**What.** The project a chat joined (`lightcone_project`) and the agent's
permission mode (`acp_config_options`) live in the chat document's metadata,
which the frontend reads from the `sharedModel` behind `IChatModel`, checked by
shape.

**Why.** `IChatModel` exposes no chat-level metadata; the `jupyterlab-chat`
model that holds it is not a dependency here.

**Upstream.** `@jupyter/chat`: `readonly metadata` and `metadataChanged` on
`IChatModel`; jupyterlab-chat: `YChat.getMetadata()`.

**Removal.** Read the model's metadata.

### Links and images in replies are rewritten in the DOM

**Where.** `src/chat-links/link-fixer.ts`; the three Jupyter Chat class
names the extension needs (input box, message list, rendered message) are
restated once in `src/chat-links/chat-dom.ts` with their upstream source,
since only the message container class is exported.

**What.** Agents write absolute server paths. A capture-phase click handler
opens such links in JupyterLab and a `MutationObserver` rewrites image sources
to the `files/` route, both keyed on Jupyter Chat's rendered-message class.

**Why.** Jupyter Chat renders Markdown with the application registry and no
URL resolver or link handler, and its DOM classes are not exported.

**Upstream.** `@jupyter/chat`: `resolver` and `linkHandler` options for the
message renderer (a `rmRegistry.clone`), and exported DOM hooks.

**Removal.** Pass a resolver; delete the observer and the handler.

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

### MIME renderers are disposed through a custom element

**Where.** `src/astra-mime.tsx` (`AstraCardElement`, `AstraMimeRenderer`).

**What.** ASTRA cards render through a custom element whose connection
callbacks mount and unmount the React tree, so project leases and effects are
released when a message is deleted or a chat closes.

**Why.** Jupyter Chat 0.25 mounts a rendermime widget's node and never
disposes the widget.

**Upstream.** `@jupyter/chat`: dispose the renderer when the message is
rerendered, deleted or the chat closes.

**Removal.** A plain `Widget` with `dispose()`.

### Chip clicks stop propagation

**Where.** `src/comments/comment-tray.tsx` (the chip's click handler).

**Why.** `ChatWidget` refocuses the input on any click inside its node.

**Upstream.** `@jupyter/chat`: skip the refocus for clicks on interactive
elements.

### Messages are found by their index attribute

**Where.** `src/comments/comment-hosts.ts` (the session host).

**What.** A text selection in a transcript is mapped to its message through
the exported message container class and its `data-index`.

**Upstream.** `@jupyter/chat`: `data-message-id` on the container.

### Session tabs show their title through CSS

**Where.** `src/sessions/session-manager.ts` (`syncSessionTabTitle`),
`style/sessions.css`, `src/tab-labels/` and `style/tab-labels.css`.

**What.** A session's tab shows the first line of its first message and, when
two projects' tabs collide, its project's folder. Both travel in the public
`Title.dataset` and are painted by `::before` and `::after` over Lumino's
label, which stays the file name; the active tab's top bar is redrawn with a
JupyterLab private variable.

**Why.** `DocumentWidget` renames the file whenever `title.label` changes, and
Lumino's `Title` has no secondary label.

**Upstream.** `@jupyterlab/docregistry`: an opt-out of rename-on-label;
`@lumino/widgets`: `Title.sublabel` rendered by the default tab renderer.

**Removal.** Set the label; delete both stylesheet blocks.

### Session listings are polled

**Where.** `src/sessions/session-manager.ts` (`POLL_INTERVAL`).

**Why.** Jupyter Chat's WebSocket transport writes chat files directly, so
neither `contents_service` events nor `Contents.IManager.fileChanged` fire.

**Upstream.** jupyterlab_chat: a `message` Jupyter Event, or saving through
the contents manager.

### Persisted MIME models come back as dicts

**Where.** `agent_tools.py` (`_existing_card`).

**Why.** `Message(**dict)` leaves `mime_model` a dict; no `__post_init__`.

**Upstream.** jupyterlab_chat: hydrate `mime_model` in `Message`.

### Chat files are parsed for the listing and the search

**Where.** `jupyterlab_lightcone/sessions.py`.

**What.** Sessions are listed and searched from their `.chat` files, read
through the contents manager and parsed with Jupyter Chat's `Message` and
`User` dataclasses, item by item.

**Why.** jupyterlab_chat has no read-only loader that needs no room.

**Upstream.** jupyterlab_chat: a tolerant `load_chat(text)`.

### Commands and the factory are named by string

**Where.** `src/workbench-ids.ts` (`CREATE_CHAT_COMMAND`, `CHAT_FACTORY`).

**Upstream.** `@jupyter/chat`: export the `jupyterlab-chat` command ids and
factory name.

### The rendered-message wrapper is unclipped

**Where.** `style/base.css` (`.jp-chat-rendered-message.jp-OutputArea`).

**Why.** Jupyter Chat's output-area wrapper clips a card's hover shadow; the
class is not exported.

**Upstream.** `@jupyter/chat`: a documented hook on the wrapper.

### The message list is mutated in place

**Where.** `src/chat-links/turn-results-footer.tsx` (revision counters as
memo dependencies).

**Why.** `IChatModel.messages` is mutated in place and only signals announce
the change, so memos need a changing dependency.

## JupyterLab and Lumino

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

### Search sections are ordered with circled digits

**Where.** `src/search/search-palette.ts` (`sectionCategory`, `formatHeader`).

**Why.** `CommandPalette` sorts equally matched items by category text before
rank and takes no comparator.

**Upstream.** `@lumino/widgets`: `CommandPalette.IOptions.compareCategories`
or a category rank.

### Contents changes are polled

**Where.** `src/project-data-service.ts`, `src/sidebar/sidebar-model.ts`
(`CoalescingRunner`), `src/materialization-status.ts`.

**Why.** Files written by `lc`, agents and git never reach
`Contents.IManager.fileChanged`; Lumino's `Poll.refresh()` cancels a refresh
requested while one runs, hence the runner.

**Upstream.** jupyter_server: contents change events from a filesystem watcher;
`@lumino/polling`: `Poll.refresh({ queue: true })`.

### The absolute server root is published

**Where.** `jupyterlab_lightcone/application.py` (`_publish_server_root`),
`src/chat-links/chat-paths.ts` (`serverRoots`).

**Why.** `serverRoot` collapses `$HOME` to `~`, which no absolute path an
agent writes can be matched against; jupyter-lsp's `rootUri` is read as a
second spelling with symlinks resolved.

**Upstream.** jupyterlab_server: a `serverRootAbsolute` page option.

### History reads apply the hidden-file rule by name

**Where.** `jupyterlab_lightcone/versions.py` (`validate_source_path`).

**Why.** `ContentsManager.is_hidden` needs a path on disk; a blob from a commit
has none, so only the dot-segment rule is applied, honouring `allow_hidden`.

**Upstream.** jupyter_core: a name-only `is_hidden_name`.

### The content route copies the files handler's policy

**Where.** `versions.py` (`OutputVersionContentHandler`).

**Why.** The CSP sandbox and same-site XSRF check are hard-wired on
`FilesHandler`; no mixin exists.

**Upstream.** jupyter_server: a public mixin.

### A hidden directory listing is repainted by re-sorting

**Where.** `src/project-browser.ts` (`refreshMarkers`).

**Why.** `DirListing` skips its refresh while hidden and exposes no
`refreshItems()`.

**Upstream.** `@jupyterlab/filebrowser`: rebuild on attach, or a public refresh.

### The sessions route is not `api/sessions`

**Where.** `sessions.py` (`setup_session_handlers`).

**Why.** Galata's `Routes.sessions` regex is unanchored and would mock any URL
containing `/api/sessions` in the UI tests.

**Upstream.** `@jupyterlab/galata`: anchor the runner routes to the base URL.

### Two themes share one stylesheet

**Where.** `src/theme/index.ts`, `style/themes/index.css`.

**Why.** The builder compiles one `themePath` per package.

**Upstream.** `@jupyter/builder`: several theme entries per package.

### The launcher section icon is replaced

**Where.** `style/base.css` (the launcher section rule).

**Why.** A launcher category's icon is its first item's command icon; there is
no per-category icon.

**Upstream.** `@jupyterlab/launcher`: `categoryIcon`.

### A dialog body keeps its own controls unstyled

**Where.** `src/project-notifications.tsx` (`UnstyledBodyRenderer`).

**Why.** `Dialog.Renderer.createBody` runs `Styling.styleNode` on every
button in a body, which would restyle the update list's link buttons; the
renderer option is public, so a subclass skipping the styling replaces a CSS
override.

**Upstream.** `@jupyterlab/apputils`: a `styleBody: false` option.

### Focus returns to a session on a timer

**Where.** `src/sessions/session-manager.ts` (`_onCurrentChanged`).

**Why.** `ILabShell.currentChanged` fires from the closing widget's `disposed`
signal, before the dock has switched tabs.

**Upstream.** `@jupyterlab/application`: a post-layout signal.

### An optional shared package is imported lazily

**Where.** `src/sessions/agent-continuity.ts`, `src/sessions/index.ts`
(`await import('@jupyter-ai/persona-manager')`).

**Why.** A shared module that is not bundled rejects the whole extension when
absent, and bundling would create a second `Token`.

**Upstream.** JupyterLab builder: `optional: true` in `sharedPackages`.

### Comments and the project agent are stored in a hidden folder

**Where.** `jupyterlab_lightcone/project_store.py`, `comments.py`,
`agent_defaults.py`.

**Why.** `<project>/.lightcone/` is the folder the engine's `.gitignore`
template ignores, and the Contents API refuses hidden paths unless
`allow_hidden` is on server-wide; the stores are read and written on disk,
atomically, after the routes authorised the project through the manager.

**Upstream.** lightcone-cli: a visible, ignored per-project folder in the
template (then the stores become ordinary Contents paths).

## ASTRA UI and SDK

### Middle clicks are emulated on record links

**Where.** `src/element-widget.tsx` (`RECORD_TRIGGERS`, the `onAuxClickCapture`
handler).

**Why.** ASTRA UI's open callbacks receive no pointer event and its triggers
do not handle `auxclick`.

**Upstream.** `@astra-spec/ui`: pass the event or a `newTab` flag to every
`onOpen*` callback and fire them on middle click.

### The paper kind glyph's markup is restated

**Where.** `src/astra-kind.tsx` (the plain-DOM kind mark), guarded by
`src/__tests__/astra-kind.spec.tsx`.

**Why.** `surfaceGlyph(kind)` gives the text glyphs, but the paper mark is an
SVG only the React `KindGlyph` renders; surfaces Lumino draws (palette rows,
menus) need a DOM node, so the markup is restated and a test fails when it
drifts from `KindGlyph`'s render.

**Upstream.** `@astra-spec/ui`: a non-React `kindGlyphElement(kind)`, or the
SVG path data beside `surfaceGlyph`.

### The embedded dialog is restyled as a page

**Where.** `style/base.css` (`.jp-jupyterlab-lightcone-element-content`
rules).

**Why.** Record tabs show `DetailDialog` in embedded mode, which is still laid
out as a bounded panel; the rules target the documented `data-slot` hooks and,
where none exist (`astra-output-detail__result`, `__provenance`,
`astra-paper-detail__artifact`, `astra-insight-list`, `astra-decision-options`,
`astra-figure-zoom` in `base.css` and `versions.css`), the BEM classes.

**Upstream.** `@astra-spec/ui`: a `layout="page"` for the detail dialog.

### The isolation reset forces host controls into a layer

**Where.** `style/base.css` (the `@layer` declaration), `style/comments.css`,
`style/home.css`.

**Why.** `isolate.css` resets everything inside an `astra-isolate` root with
`all: revert-layer`, so host controls placed inside must live in a layer
ordered after ASTRA's; the layer names are restated because CSS cannot order a
layer after another stylesheet's layers without naming them.

**Upstream.** `@astra-spec/ui`: document the layer order, or scope the reset
to its own parts.

### Commentable figures are found by a BEM class

**Where.** `src/comments/comment-hosts.ts` (`ElementHost`),
`style/comments.css`.

**Upstream.** `@astra-spec/ui`: `data-slot` on the artifact figure.

### Pins and highlights are measured overlays

**Where.** `src/comments/image-layer.ts`, `text-layer.ts`,
`comment-layer.ts`.

**Why.** Neither ASTRA UI, JupyterLab's image viewer nor the Markdown viewer
offers an annotation slot, so markers sit beside React- or pdf.js-owned DOM
and follow it by measurement.

**Upstream.** `@astra-spec/ui`: an annotation slot on figures and paper pages.

### Paper pages are found by `data-page`

**Where.** `src/comments/text-layer.ts`, `selection-button.ts`.

**Upstream.** `@astra-spec/ui`: document the attribute.

### The MySTRA path grammar is vendored

**Where.** `src/vendor/mystra-path.ts`, `src/vendor/MYSTRA-LICENSE`.

**Why.** `@astra-spec/sdk` 0.1.2 exports no authored-path parser.

**Upstream.** `@astra-spec/sdk`: export `parseAstraPath`,
`canonicalRecordPath` and their types.

**Removal.** Delete the file, its licence and the `pyproject.toml` shared-data
line.

### Derived record fields are stripped by name

**Where.** `src/project-changes.ts` (the ignored-field sets).

**Why.** The SDK adds resolved fields to records with no runtime list of them;
the sets are typed against the SDK's types so drift fails `tsc`.

**Upstream.** `@astra-spec/sdk`: a runtime list per record kind, or the
authored record kept on the resolved one.

### Scroll and focus are restored around asynchronous previews

**Where.** `src/versions/scroll-restore.ts`, `src/versions/focus-restore.ts`,
`src/element-widget.tsx`.

**Why.** A record body keeps growing while its figure and provenance load,
and `ArtifactPreview`/`OutputDetail` expose no `onLoad` or `onSettled`, so a
restored scroll offset is re-applied from a `ResizeObserver` until reached (or
the reader interacts); focus lost to a re-render is put back on the widget
through the public `ReactWidget.renderPromise`.

**Upstream.** `@astra-spec/ui`: an `onSettled` callback on the previews.

### The dialog is closed synchronously before a tab opens

**Where.** `src/inventory-panel.tsx` (`flushSync` in `beforeOpenDocument`).

**Why.** Opening a file tab activates it at once; the ASTRA dialog must be gone
first, and ASTRA UI's open callback is synchronous.

**Upstream.** `@astra-spec/ui`: an async open callback awaited before the
dialog closes.

### The card payload is spelled on both sides

**Where.** `agent_tools.py` (`ASTRA_MIME_TYPE`, the payload), `src/astra-mime-data.ts`.

**Why.** The server publishes the card from a result the browser validated,
and Python and TypeScript cannot share one constant.

## astra-tools

**Where.** `jupyterlab_lightcone/routes.py`.

- `astra-tools` is pinned exactly (`==0.2.17`): the paper cache and the
  downloader are called in process and the package promises no stable API.
- arXiv DOIs are re-capitalised before download because the downloader
  matches the `10.48550/arXiv.` prefix case-sensitively. **Upstream:** a
  case-insensitive match.
- The paper cache is re-indexed for a case-insensitive, containment-checked
  lookup, which `PaperCache` lacks. **Upstream:** `PaperCache.find(doi)`.

## lightcone-cli

What the workbench needs from the engine. The engine is called in process
(`materialize.status`, `project.converge`, `plan.build`) and pinned below
0.6 because it promises no stable API; declaring the read-only surface the
extension uses as public would let the pin follow semantic versioning.

### Ignore `chats/` and `*.chat` in the project template

Sessions are Jupyter Chat documents under `<project>/chats/`. `lc materialize`
refuses to start on a dirty tree, and the extension never writes to `.git` or
`.gitignore`, so the template's `gitignore.tmpl` has to ignore them (being
added on the engine side). The template already ignores `.lightcone/`, where
the comment store and the project's recorded agent live.

### Expose run records, not only commit subjects

The engine writes DataLad's `[DATALAD RUNCMD]` record into each
materialization commit; the Run tab shows the manifest sidecar's facts only.
**Upstream:** record the command (and exit code) in the manifest, or provide
`lc log --json`.

### Report when an output was last materialized

`lc status --json` names the commit (`git_sha`) but not its time; Home's
freshness line and the **Materialized during this reply** footer read commit
times from the repository with dulwich. **Upstream:** an ISO 8601 time beside
`git_sha` in each `OutputStatus`.

### Find git-annex beside the engine, not only on `PATH`

`require_git_annex()` probes `PATH`; the git-annex wheel installs its
executable beside `lc`, which a server started without activating the
environment does not have on `PATH`. `projects.expose_engine_tools` appends
the interpreter's scripts directory to `PATH` at load, for the in-process
`converge`; the extension's own annex reads resolve the executable themselves
(`annex.py`). **Upstream:** resolve the executable from the interpreter's
scripts directory first.

### Publish the output file location

The versions routes locate an output's file with `plan.build(...)` and fall
back to the repository's `results/` listing for outputs the spec no longer
declares; the manifest sidecar is a hidden file
(`results/<universe>/.<output>.manifest.json`) read from disk because the
Contents API refuses hidden paths. **Upstream:** declare `plan.build` and
`Task.output_path` (or a `path` in `OutputStatus`) public, and write the
manifest without the leading dot or expose it through `lc status --json`.

### Notify when the status changes

Materialization status is polled (the `jupyterlab_lightcone:materialization`
poll, refreshed on project file changes) because the engine offers no change
notification for `lc status`. **Upstream:** a status change event, or a
cheap status revision to compare.

### A visible folder for the workbench's stores

See [Comments and the project agent are stored in a hidden
folder](#comments-and-the-project-agent-are-stored-in-a-hidden-folder).

## git-annex

**Where.** `jupyterlab_lightcone/annex.py`, `versions.py` (`annex_state`).

The bytes of older versions are asked of git-annex through documented
commands with JSON output (`lookupkey --ref`, `examinekey`,
`whereis --batch-keys`, `contentlocation`), so no pointer, key or object path
is spelled here. One thing is: a clone nobody ran `git annex init` in is
recognised by the presence of a `*/git-annex` ref without an `annex.uuid`,
because every git-annex command, `lookupkey` included, would initialise it.
**Upstream:** a read-only query that never initialises.
