# Lightcone Lab

The open AI-assisted research workbench

**Lightcone Lab** brings a research workbench into JupyterLab, connecting
methods, evidence, and computation. The extension currently provides an ASTRA
analysis inventory, materialized outputs, cited papers, and Jupyter AI integration. ASTRA is the
analysis format; `astra.yaml` and its SDK contracts retain their names.

## Requirements

- Python >= 3.11
- JupyterLab >= 4.5.10, < 5
- Node.js >= 20 for extension development or the optional MySTRA viewer

## Install

```bash
pip install jupyterlab-lightcone
```

The wheel includes the frontend, shared components, and PDF.js assets.
End users do not need Node.js or sibling source checkouts.

## Use

The **current project** is the one holding the file browser's folder: the
nearest enclosing `astra.yaml` on the current Jupyter Contents drive,
independent of file-browser filters. A nested project uses its own root. While
there is one, the status bar shows **Lightcone · _project_**; click it to open
the project's inventory. Browsing outside every project clears it. New Jupyter
AI chats join the current project (see below).

Outside a project, the launcher is JupyterLab's own plus one **New Lightcone
project** card; **Open project** stays in the command palette. Inside a project
or its subfolders, the launcher tab shows the project's [Home](#project-home-and-setup) instead.
Browse labels folders containing `astra.yaml` as **ASTRA project**; this indicates
presence, not validation of the specification.

Choose **New Lightcone project** in the launcher (or **Create project** in the
command palette), enter a project folder, or use **Browse…** to select an
existing directory. Create proposes a folder that does not exist yet,
`my-project` (or `my-project-2`, … when that is taken), beside the current
project when the file browser is inside one; you can rename it. Paths are
relative to the Jupyter server's root; absolute paths inside that root are also
accepted. **Create project** does it in one step: a folder that already holds a
Lightcone project opens directly, a folder inside another project is refused
before anything is written, and any other folder is initialized exactly as
entered, as `lc init` would, then opened. Cancelling the form creates nothing.
The extension installs `lightcone-cli` as a dependency and calls its engine
directly, so no `lc` command has to be on the server's `PATH`.
Initialization requires a local filesystem server, and the engine's own tools,
`uv` and `git`, on the server's `PATH` (`git-annex` comes with the extension,
as a wheel installed beside the server's interpreter); failures are displayed
in the form and
can be retried. After closing the form or reloading JupyterLab, run **Finish
project setup** from the command palette to resume setup, including when
`astra.yaml` already exists; file presence alone does not imply setup
completed. While setup runs, the button shows a spinner and a brief status. Each setup
action opens a fresh form so an older draft cannot override a newly selected
destination.

After opening or creating a project, the file browser navigates there and the
project's Home comes forward: the Home tab already showing it, or a new one. Inventory and Lightcone Agent commands
invoked in a folder without `astra.yaml` offer the same setup form.

Open `astra.yaml` in the file browser, or select **Open With → Lightcone Lab**.
Home's **Open ASTRA**, the full launcher's Lightcone cards and the command
palette also offer **ASTRA Inventory**. The inventory is read-only: viewing preserves analysis and
result files and starts no kernel. JupyterLab may create its standard document
checkpoint when opening a writable file; the normal text editor remains
available for editing.

The inventory shows outputs, decisions, inputs, findings, and a bibliography
using the shared ASTRA components. Prior insights remain accessible through their
decisions and source papers. The project hierarchy in the sidebar lists the
analysis and its sub-analyses; select a name to switch analyses. Select a record
to inspect its details. Figures, CSV/TSV tables, and JSON tables/metrics have
bounded previews and an action to open the full artifact in a JupyterLab document
tab, using the file's default viewer. Opening an artifact again reveals its
existing tab. Paths, universe selection, validation, and artifact cache tokens
come from `@astra-spec/sdk`.

Inventory results show a small marker when the Lightcone engine reports them as
**Behind** (still valid, but the environment moved since) or **Stale**
(definition or input changed, hand-edited, or never materialized). Hover over it
to see the state and the reason; both are the engine's own, the ones `lc status`
prints. Current results show no extra marker. Status checks run every 15 seconds while the page is
visible and after local file changes. Engine failures clear markers and show one
message in the headbar; status returns automatically after recovery. The
integration currently covers local root-analysis outputs.

Open a result to see its **Provenance** below Recipe: status, last run, and Git
revision. The provenance tabs expose the recorded recipe, input versions,
environment, and Lightcone version without leaving the result.

Output details also offer **Open code** beside Recipe when a local script can be
resolved. It opens the current file in a reusable editor tab, preferring the
command from the recorded run over the declared recipe; the link's tooltip
names which one applied. This supports direct script commands in the root
analysis, including a script named through an `{inputs.<id>}` placeholder,
which resolves to that input's declared source. Interpreter options before the
script and redirections, globs or comments after it are fine. Module, inline,
and compound commands or unresolved paths have no link, and neither does an
output whose run record cannot be read. This link opens the current script;
the Code tab separately displays the revision recorded by an earlier run.

Launcher actions use the launcher's directory. Palette actions use the current
project/document or file-browser directory. Opening the same project reuses its
document tab; different projects keep their own selection and dialogs. You can
also open an explicit project programmatically:

```typescript
app.commands.execute('jupyterlab_lightcone:open-inventory', {
  path: 'research/astra.yaml',
  analysisPath: '$'
});
```

Projects refresh after relevant file operations, through **Refresh ASTRA
Inventory**, and by polling while the browser is visible. Multiple views of the
same project share that work. A transient invalid edit preserves the last valid
view and displays a notice until the project recovers.

### Project updates

While a project is open in an inventory, record, or chat view, a small JupyterLab
notification groups meaningful edits and newly available results. **Review changes**
opens a compact list linking to affected records; removed items remain listed.
Decision selections show their previous and new labels. Changes to inputs,
outputs, decisions, findings, insights, cited papers, and the project hierarchy
are included. Renames/moves that change an ID appear as a removal and addition.

Initial loading/reopening, navigation, YAML formatting/order, insight timestamps,
and paper-cache activity stay quiet. Notifications group changes over three
seconds, share one outstanding notification per project/universe, and hide the
toast after five seconds while retaining it in JupyterLab's notification center.
They never activate another tab automatically. This is session activity, not a
persistent audit log; monitoring stops when the last project view closes.

Result rewrites are compared using server-side Contents hashes, requested only
when artifact metadata changes (and once on initial load). Identical rewrites
stay quiet. Custom drives without hashes still report newly available results,
but cannot report content changes to existing results. Input file contents are
not monitored: input notifications concern their ASTRA declarations.

### MySTRA Viewer

Choose **Open report** on Home, or **MySTRA Viewer** in the full launcher,
command palette, or file-browser context menu. Lightcone finds the nearest `myst.yml` or `myst.yaml`, starts its
MyST CLI, and opens the actual ASTRA article/book application in a tab. Opening
the same project reuses the viewer. Saved Markdown and research data changes
are handled by MyST's watcher; unsaved editor changes are not rendered.

The MyST CLI is installed with the extension (the `mystmd` package), and the
viewer always runs that copy with the server's own Python, even when the
server's environment is not activated or another `myst` comes first on `PATH`. The **Jupyter server's**
environment must still provide Node.js 20 or later; without it, the viewer
reports that Node.js is missing rather than installing it. Projects also need
their MySTRA plugin and an ASTRA theme implementing `mystra-viewer.v1`. It is a
MySTRA viewer, not a universal MyST theme preview. Older ASTRA versions and
stock MyST themes produce an actionable compatibility error. The project
retains its own `site.template` and plugin configuration; Lightcone does not
substitute a renderer. The first theme launch may install its dependencies and
require network access.

MyST keeps the built site and downloaded themes in the project's `_build`
folder. Deleting `_build`, or running `myst clean --site` or
`myst clean --templates`, while a viewer is open restarts MyST within a few
seconds: it rebuilds the site, downloads the theme again if needed, and the tab
reloads the report. To pick up a newer ASTRA theme, run
`myst clean --templates` in the project; **Restart MySTRA Viewer** alone reuses
the cached theme. See
[MyST’s theme update instructions](https://mystmd.org/guide/update-myst).

The tab shows status and a bounded build log during startup or on errors;
the controls disappear when the report is ready. **Restart MySTRA Viewer** in
the command palette stops and restarts the active project's process group.
Closing the tab stops its heartbeat; processes expire after two minutes
without a viewer and stop when Jupyter shuts down. Choosing **MySTRA Viewer**
again after closing opens a new tab, reusing the process while it is still warm
or starting a new one after expiry. An expired tab explains
that its session ended and offers a restart. If another process takes one of
the ports chosen for MyST, the tab reports it and a restart picks new ports. Up to five sessions can run at once. Each session belongs to its Jupyter
identity, and different project directories receive distinct routes/processes.

Opening a viewer executes the project's configured plugins and theme as the
Jupyter server user. Use trusted projects. An authorizer must permit `execute`
on the `mystra` resource and `read` on `contents`. Site content and WebSockets
remain behind Jupyter authentication, including JupyterHub URL prefixes. The
iframe shares Jupyter's origin and is not a security sandbox for untrusted code.
Only a local filesystem ContentsManager is supported, and the Jupyter server
must run on a POSIX system; Windows servers receive a clear error because
process-group cleanup is not implemented there.

The viewer has no configuration; startup may take up to two minutes. It is a
temporary, self-contained plugin: its own server extension
(`jupyterlab_lightcone.mystra`, loaded with the package) and frontend plugin
(`jupyterlab_lightcone:mystra`). Disable the frontend plugin with
`jupyter labextension disable jupyterlab_lightcone:mystra`.

The integration was validated with MyST 1.10.1 and 1.11.0 and Node.js 22/26.
It requires the companion [ASTRA theme changes](https://github.com/LightconeResearch/astra-theme/pull/16)
and the documented `mystra-viewer.v1` contract.
No separate preview domain or publicly exposed Node port is needed.

### Cited papers

Cached papers are read from and fetched into ASTRA's conventional cache,
`~/.cache/astra/papers` in the Jupyter server user's home directory, which the
`astra` command line shares. The location is not configurable. On JupyterHub
each single-user server uses its own user's cache.

Missing PDFs are downloaded only when you choose **Fetch paper**, using
`astra-tools==0.2.17`. Cache lookup and download failures do not prevent viewing
the analysis. Cached PDFs are served from the authenticated Jupyter origin and
support continuous scrolling, zoom, and navigation to cited passages.

### Jupyter AI: rich references and agent navigation

Jupyter AI 3.2 (Jupyter Chat 0.25) is installed with the extension. Configure an agent through
Jupyter AI as usual. With an inventory open (or its folder selected), run
**Lightcone Agent** from the command palette or the **Lightcone Lab**
launcher section at the top of the launcher page. The gold chat shortcut opens
Jupyter Chat in the left sidebar and uses the
launcher’s current folder. Outside an ASTRA project it opens the folder-selection and project-creation form. The composer opens empty, and your
message is sent to the agent exactly as written: Lightcone adds no context text.

Instead, the agent starts in the right place: its session's working directory is
the root of the chat's ASTRA project, so `lc`, `astra` and relative paths work
without naming the project. Every Jupyter AI chat has a project, however it was
opened (the Jupyter Chat sidebar's **+**, the launcher's **Chat** card,
**File › New**, or an existing `.chat` file):

1. A chat stored inside a project belongs to it: the nearest folder at or above
   the chat containing `astra.yaml`. Chats can live beside `astra.yaml` or in a
   subfolder such as `chats/`.
2. Any other chat joins the [current project](#use) when it is first opened,
   and the `.chat` file records it (`lightcone_project` in its metadata). It
   keeps that project when you browse to another one; open a new chat there.
   If the recorded project is removed, the chat joins the current one again.
3. A chat opened while no project is current keeps Jupyter AI's default, its
   own folder, until it joins one.

Jupyter AI starts the agent session as soon as the chat opens, so the browser
reports the current project to the server as it changes, and again when its
window regains focus; with several windows, the one used last decides. A chat
that joins a project after its session started (rule 3) keeps its first folder
until the session is recreated, although the tools already address the project.

A deployment that configures a different
`PersonaManagerExtension.persona_manager_class` keeps its own class and opts out
of the working directory, though not of the tools' rule; subclass
`jupyterlab_lightcone.agent_workspace.PersonaManager` to keep the behavior.
Jupyter AI also looks for `.jupyter` (MCP settings, local personas) from the
project root upward, so one stored below it, beside a chat in `chats/` for
example, is no longer found. Likewise, once a chat stored elsewhere joins a
project, a `.jupyter` in the chat's own folder no longer applies; the
project's does.

Ask the agent to show an ASTRA element in chat, for example:

> Show preview cards for decisions.covariance_source and outputs.bao_fit_plot.

The agent calls `lightcone_preview_element`, which inserts a rich MIME card into
its conversation. Cards display the existing ASTRA previews directly, including
supported figures and tables. Click a card to open it in a tab; links and controls
inside the card keep their own actions. They persist in saved
chats and retain the universe each card recorded when it was created. Cards
for committed root-analysis outputs pin that commit: both the preview and the
record tab opened from it show the recorded bytes, including while the newest
commit has uncommitted edits. A missing or unreadable recorded version is
reported as unavailable; it never silently substitutes current output data.
The text fallback remains readable without Lightcone installed. These cards work
with both the stock Markdown renderer and `jupyterlab-myst` enabled.

The agent reads `astra.yaml` and referenced project files directly using its
existing file tools. The built-in Jupyter MCP server adds two presentation tools:

- `lightcone_preview_element(target)`: display a card in chat (the default presentation).
- `lightcone_open_element(target)`: open or reuse a native ASTRA tab.

`target` is an element path such as `decisions.covariance_source`. The project is
the calling chat's, by the same rule that roots the agent's shell, so the agent
never passes a project path. Multiple universes are not yet selectable from
chat. Tools require a connected originating browser and a chat with a project.
Cards are attributed to the calling agent; repeated previews of the same target
in one prompt reuse the card.
The **Lightcone Agent** command reuses the active session of the project, or
creates one through the session service. A record discussion leaves a draft in
the composer for the user to send. File links in agent replies open through
JupyterLab's document manager beside the conversation; directories open in the
file browser. Server-local image links use authenticated Jupyter file URLs.

The last agent message of a reply lists **Results updated** and **Files
edited**. Output links open the commit that changed during that reply. The
footer includes both engine runs and manual result commits, matching bounded Git history to the reply's time window; concurrent runs
in that same window cannot be attributed to a particular agent. Edits come from
the ACP client's reported tool metadata, not a scan of arbitrary files.

Existing agent terminal tools, `lc`, and research skills remain available through
the agent's normal setup; Lightcone observes changes without starting recipes.

For direct UI integrations:

```typescript
app.commands.execute('jupyterlab_lightcone:open-element', {
  entrypoint: 'research/astra.yaml',
  target: 'decisions.covariance_source'
});
// Cited papers keep DOI identity rather than introducing a new MySTRA role:
app.commands.execute('jupyterlab_lightcone:open-element', {
  entrypoint: 'research/astra.yaml',
  target: '',
  doi: '10.1234/example'
});
```

New results reuse an unpinned preview tab in the same project, universe, and
result group. Its native tab title is italic. Choose **Pin tab**, double-click
the native tab title or a card, or use **Pin ASTRA tab**
in the tab context menu/command palette to keep that result. Moving a tab also
pins it. Later results use another preview tab alongside retained tabs.
Choose **Unpin tab**, or **Unpin ASTRA tab** in the context menu/command palette,
to make that tab reusable again. If its group already has a preview for the same
project and universe, that other tab is pinned so both results remain available.
Opening an already displayed record focuses it without creating a duplicate.
Pins keep the record's identity while its data stays live; tabs remain movable
and closable. The layout, records, and pins survive a browser reload.

Option/evidence paths open their owner.
Analysis/collection paths use the inventory, which currently supports its
automatically selected universe; other pinned universes support record tabs.
Missing outputs stay unavailable and papers download only through **Fetch paper**.

Inline `{astra}` roles in response text do not produce hover previews. The
previous Markdown DOM adapter has been removed: MyST consumes unknown roles,
and neither renderer offers a shared inline extension hook. Agents should use
the preview tool instead. Full MyST documents and block/value/citation roles
are outside this implementation. Committed output snapshots are available in
record tabs through the version controls.

See [the workaround inventory](docs/workarounds.md) for the compatibility
boundary and the upstream changes that would simplify it.

### Appearance

Inventory components use the shared Lightcone brand and follow JupyterLab's
light/dark theme without changing the surrounding shell.

The brand adapter from `@lightcone-research/brand` supplies every ASTRA UI
token; the extension does not redefine any of them from JupyterLab settings.
JupyterLab styles plain `button`, `a`, `select`, `code` and `pre` elements
throughout its shell, which would otherwise override the shared components'
layered styles (the shared `@astra-spec/ui/isolate.css` defines the boundary). Inside the inventory
those elements are handed back to the ASTRA UI and brand layers, so they render
exactly as the shared components define them.

## Troubleshoot

Check that both extensions are enabled:

```bash
jupyter server extension list
jupyter labextension list
```

After installing a new extension, restart JupyterLab. During development, build
after TypeScript changes and refresh the browser; restart the server after
Python changes.

## Uninstall

```bash
pip uninstall jupyterlab-lightcone
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the template's development, testing,
and packaging workflow, and [AGENTS.md](AGENTS.md) for repository conventions.

The ASTRA appearance follows the publication reference through the shared brand
adapter. Font assets, type sizes and kind marks come from the shared packages;
this extension owns layout, theme synchronization and the `astra-isolate` scope.

The shared rendering contract uses published `@astra-spec/ui` 0.0.7 and
`@lightcone-research/brand` 0.0.3, installed from npm.

### Project sessions

Use **New session** in the command palette to open a Jupyter Chat document in
`<project>/chats/`. Sessions open in the main area and stay beside record tabs.
An empty session's file is named after its first human message once the
conversation goes quiet; reopening an existing conversation preserves its
filename. **Lightcone Agent** reuses an open session for the project and leaves
record discussion text as an unsent draft.

The session service lists chat documents through the Contents API, respecting
its hidden-file and authorization rules. When the server extension loads, it
sets Jupyter AI's public `persona_manager_class` trait to a project-aware
persona manager, unless a deployment configured its own class. Chats outside a
project record the current project on first opening so later navigation does
not change the agent's working directory.

Chat documents must be ignored by Git before materialization; the extension
never changes a project's Git configuration. Compatibility details and upstream
removal conditions are in [the workaround inventory](docs/workarounds.md).

### Agent continuity and activity

Sessions reopen with the agent they last addressed, falling back to the agent
last used by their project. A message that names an unavailable agent is routed
to an installed remembered agent when one exists. Starting a session through
`jupyterlab_lightcone:new-session` can include `firstMessage` and `persona`
arguments; the handoff waits for the live agent listing and runs the same input
providers as Jupyter Chat. If the selected agent is unavailable, the text stays
in the composer so the user can select another agent and send it.

The session service follows Jupyter AI's public persona-state events. It
notifies the user when a session they are not viewing finishes or needs input.
The project preference is a small ignored `.lightcone/agent.json` file; no
messages or agent credentials are stored there. The workaround inventory
explains the remaining picker-selection and metadata limitations.

### Record navigation

Following a related record keeps the same tab and records a short history.
Use Back/Forward, the breadcrumb trail, or Alt+Left/Right to return to earlier
records; their scroll positions are retained. Ctrl/Cmd-click, middle-click,
and **Open in new tab** retain another native tab. Pinning protects a tab from
replacement by results opened elsewhere. Reload restores each tab and pin.

### Committed output versions

Record tabs offer Older/Newer controls for local root-analysis outputs. Each
version reads the bytes and run manifest from that commit; renamed artifacts
keep their historical filename and format. Missing git-annex content is
identified with its known remote holders and is never fetched automatically.

The listing shows at most 200 file-changing commits. A requested commit outside
that listing stays explicitly unavailable until you select **Latest**; it is
never replaced silently by the current output. Selected commits survive
Back/Forward, opening a new tab, and layout restoration.

### Inspect a recorded run

Output details expose Run, Code, Inputs, and Environment tabs. A selected
version uses its committed manifest; it never borrows facts from the current
run. Code shows the script at the recorded revision and its changes relative
to the current file, even when the current script has been deleted. Environment compares the recorded `uv.lock` packages
with today's lock. These reads start only when their tab is opened.

Code and artifact links use JupyterLab's document manager to reveal an existing
file tab. Missing, binary, annexed, or oversized historical source files have
an explicit unavailable state. These views inspect data and do not execute
recipes or install packages.

### Compare artifact versions

**Compare with previous** compares adjacent committed outputs. Images offer
side-by-side, swipe, and blink views; JSON metrics show numeric changes; CSV,
TSV, and JSON tables compare their row counts and columns. Each side uses its
historical file format, including format changes across a rename. Reads and
metric expansion are bounded, and missing bytes or unsupported format pairs
remain explicit. Selecting **Latest** closes comparison and resumes live data.

### Project Home and setup

Inside a project, launcher tabs show Home: the project title and Markdown
description, result previews with freshness, and a composer with recent
sessions. The pencil icons edit the display name or description in
`astra.yaml`, preserving the project folder and other fields. Description
editing uses its original Markdown.

Choose an available agent before **Start**. Home discovers project-local and
installed agents without creating a chat or starting an agent, suggests the
project's last agent when available, and sends the first message through the
same checked handoff as session creation. Unsent drafts survive a reload.
Results open in record tabs. **Open ASTRA** opens the full inventory;
**Open report** appears only for projects with `myst.yml` or `myst.yaml` and
opens the managed MySTRA viewer.

**Tools** groups the standard launcher's items, including kernels and cards
from other extensions, by category. **Show the full launcher** and **Back to
Home** switch that tab's body. Outside projects the standard launcher remains
available. The tab-bar plus button, File menu, keyboard shortcut, file-browser
button, and an emptied main area retain their launcher behavior.

**New Lightcone project** proposes an unused folder, beside the current
project when browsing inside one. Setup refuses a nested project before
writing, opens an existing project directly, and shows a spinner during
initialization. Cancelling creates nothing. **Finish project setup** resumes
an incomplete setup; the presence of `astra.yaml` alone does not imply success.

Home replaces `@jupyterlab/launcher-extension:plugin` atomically through the
extension manifest and its own `ILauncher` provider. Disabling Lightcone Lab
restores JupyterLab's stock launcher. Other launcher replacements conflict
with this provider.

### Project sidebar

The Lightcone icon in the left sidebar opens the current project's sessions,
results and analysis tree. **New session** starts an empty chat; **Search**
opens project-wide search. Sessions can
be renamed in place and show their live activity. Results carry the engine's
materialization state, and the selected record or analysis follows the active
tab. Home's sessions section can open the full list in the sidebar.

The project switcher lists recently visited projects and nearby project
folders, with actions to open or create another. Selecting a project moves the
file browser there; it keeps existing tabs open. When tabs from different
projects have the same visible title, their project folders appear beside
their labels. These display labels preserve document filenames.

### Project pipeline

**Pipeline** on Home's results line or in the command palette shows how the
project makes outputs from inputs, colored by the engine's materialization
status. **Show in pipeline** on an input or output record traces what feeds
that record and what depends on it. The graph explains the trace in words and
dims unrelated nodes; **Show everything** or Escape clears it.

Opening the graph from a record places it in the neighboring column. Clicking
a graph node opens its record beside the graph, preserving both views. Each
project has one reusable pipeline tab, and restoring the layout retains its
trace. The graph is read-only: it starts no computation or materialization.

### Comments

Click a figure in a record tab or an image opened in JupyterLab to pin a comment
at that point, or select text in a record, a Markdown preview, a text editor, a
cited paper or a message of a session and choose **Comment**. Comments are
numbered per target (①, ②, …), pinned to the version they were made on, and
kept in `<project>/.lightcone/comments.json`; pins on images can be dragged,
and every pending comment can be edited or deleted. Pending comments appear as
chips above the composer of every session in the project and as a count in the
sidebar; a chip opens its target. Sending the next message in a session sends
the pending comments with it: the agent's prompt gains a short list of them, the
chat keeps your message as typed and shows them as cards on it, and they leave
the pending list. Where a deployment configures its own Jupyter AI persona
manager, which does not append them to the prompt, the list is appended to the
message text itself instead.

### Search

Ctrl+K (Cmd+K on macOS), **Search** in the sidebar, or **Search Lightcone
project** in the command palette searches the current project's sessions (by
title, then, once you pause typing, the text of their messages under **In
sessions**), records (results, decisions, inputs, findings, papers), files and
Lightcone commands. Sessions open in the main area, records as record tabs,
files in their default editor.

In the composer, `@` completes the project’s records (`@hub` offers
`outputs.hubble_diagram`, inserted with its current version) and `#` completes
its sessions as `chats/…` file references.
