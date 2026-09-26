# Lightcone Lab

The open AI-assisted research workbench

**Lightcone Lab** brings a research workbench into JupyterLab, connecting
methods, evidence, and computation. Inside a project it provides a
[Home](#home) page, a [project sidebar](#lightcone-sidebar), agent
[sessions](#sessions), [record tabs with result versions and
provenance](#record-tabs-versions-and-provenance),
[materialization status](#materialization),
[comments](#comments), [search](#search)
and two [Lightcone themes](#appearance), on top of an ASTRA analysis
inventory, materialized outputs, cited papers, and Jupyter AI integration.
ASTRA is the analysis format; `astra.yaml` and its SDK contracts retain their
names.

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
or its subfolders, the launcher tab shows the project's [Home](#home) instead.
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

### Home

Inside a project, the launcher tab is the project's front page. A header names
the project path and holds **Tools ▾**, which lists the launcher's items by
category (kernels and other extensions' items included; Lightcone's own cards
are on Home itself) and ends with **Show the full launcher**; that tab then
shows the stock launcher, with **Back to Home** to return. Every way of opening
a launcher keeps working and keeps its folder: the tab bar's **+**, **File › New
Launcher**, Ctrl+Shift+L, the file browser's button, an emptied main area and
`/lab/tree/...` URLs. Browsing into or out of a project switches an open tab
between Home and the stock launcher.

The left column opens like a book's title page: the project's name over a
rule, its description rendered as Markdown, and a line counting what the ASTRA
analysis holds (results, decisions, inputs, findings, papers, each with the
kind mark the inventory uses). The description's pencil opens its original
Markdown for editing. Below them, **Open report** (only when the project has a
`myst.yml` or `myst.yaml`; it opens the [MySTRA Viewer](#mystra-viewer)) and
**Open ASTRA**, which opens the ASTRA inventory; the report's button is the
filled one, and **Open ASTRA** takes the fill when there is no report. Result
plates follow under the **Results** heading and its freshness line, with
**Pipeline** (the graph behind that line, see
[record tabs](#record-tabs-versions-and-provenance)) and **All _n_ results**
leading to the inventory. Results past the first eight plates are named in a
line after them, each opening its result.
When results are stale or behind, the freshness line names them (see
[materialization](#materialization)); materializing is the agent's job, or
yours in a terminal. The right
column is the desk, beside the title page from the top: a composer with an
agent picker and **Start**, then recent sessions with a working or
needs-input marker. In a tab narrower than 900 pixels the page is one column:
the title page, the composer, the results, then the sessions. **Start** is the
only action on Home that sends a message. The **Agent** picker lists the project's available
agents before its first session opens. It suggests the project's last agent,
an available configured default, or its sole agent; otherwise choose one before
pressing **Start**. The first message waits for the chat's agent list and is
sent only if the chosen agent is available. Home reads JupyterLab's theme variables, so it looks
native under any theme; the Lightcone themes set its title, the rule under it
and its links' rules in antique gold. Showing it starts no kernel, MyST or
recipe.

The small pencil beside the project title opens **Rename project** and saves
its display name. Project folders and file paths stay the same.
Use the pencil icon beside the description to edit its paragraphs, or
**Add description** when it is empty. Saving updates the analysis description.

The extension replaces `@jupyterlab/launcher-extension:plugin` through
`disabledExtensions` in its `package.json`. Disabling Lightcone Lab
(`jupyter labextension disable jupyterlab-lightcone`) restores the stock
launcher. Other launcher replacements, such as `jupyterlab-launchpad` or
Elyra's, conflict with it.

### Lightcone sidebar

The Lightcone icon in the left sidebar (or **Show Lightcone Sidebar** in the
command palette) opens the project's navigation: its name with a project
switcher (▾) and a Home button, **New session**, **Search**, the sessions
(renamable, with activity markers), results with their materialization status,
the analysis tree with record counts, the
number of pending [comments](#comments). The switcher lists recently visited projects and the other
projects in the same folder, plus **Open project…** and **New Lightcone
project**; choosing one moves the file browser there, and the current project
follows. The sidebar never closes or swaps tabs when the project changes. When
two projects' tabs would read the same (two `astra.yaml` inventories, two
Homes, two records called "Hubble diagram"), each such tab shows its
project's folder name after its label. Outside a project the sidebar offers
**New project**.

### Sessions

A session is a Jupyter AI chat stored in `<project>/chats/`, named after its
first message (`chats/hubble-diagram-with-error-bars.chat`). **Start** on Home
and **New session** in the sidebar create one and open it in the main area;
**Lightcone Agent** does the same unless a session of the project is already
open, which it focuses instead. A session started empty is created as
`chats/untitled.chat` and renamed after its first message once you send it;
the open tab follows the rename. Tabs, the sidebar and Home show a session's
title (the first line of its first message), and the sidebar can rename its
file. Creating a session also creates `chats/` if needed; the extension never
touches the project's Git configuration, so `chats/` has to be ignored by the
project's own `.gitignore` for `lc materialize` to run with sessions present
(see [docs/workarounds.md](docs/workarounds.md)). Results opened from a
session split to its right, later results join that group, and closing them
returns focus to the session. A session that finishes, or asks for
permission, while you look elsewhere raises a notification with **Open
session**. An empty session shows the project name and "What
would you like to explore?".

Every chat opens with the agent it last addressed, or else the one its project
last used, wherever it opens: the main area, the side panel, after a move
between them, when reopened or after a reload. Jupyter AI's own picker starts
each new view from the server's default persona, which is often not an
installed one. The server records each project's agent in
`<project>/.lightcone/agent.json` (an ignored folder, beside the comment
store), and sends a message that names no installed agent (the picker on **No
one**, say) to the chat's usual agent instead of dropping it. **Start** on Home
with **Default agent** uses the project's agent too. A chat open in two views
at once keeps each view's own choice.

In the composer, `@` completes the project's records
(`@hub` offers `outputs.hubble_diagram`, inserted with the version it has now)
and `#` completes the project's sessions (inserted as their `chats/…` file), so
the agent reads exactly what you referred to. When the ACP client records an
agent's plan in its message (the Agent Client Protocol's plan entries under
`plan`), the message shows it as a checklist, "Plan · 3 of 5";
`jupyter-ai-acp-client` 0.3.0 does not record plans yet.

Replies link back into the workbench: links to absolute paths under the server
root open those files in JupyterLab, images at such paths render, and the last
reply of a turn lists the outputs materialized during it (**Materialized during
this reply**) and the files the agent edited (**Files edited**).

### Inventory

Open `astra.yaml` in the file browser, or select **Open With → Lightcone Lab**.
The full launcher's **Lightcone Lab · _project_** section, Home's **Open
inventory →** and the command palette also offer **ASTRA Inventory**. The
inventory is read-only: viewing preserves analysis and result files and starts
no kernel. JupyterLab may create its standard document checkpoint when opening a
writable file; the normal text editor remains available for editing.

The inventory shows outputs, decisions, inputs, findings, and a bibliography
using the shared ASTRA components. Prior insights remain accessible through
their decisions and source papers. The project hierarchy beside the inventory
lists the analysis and its sub-analyses; select a name to switch analyses.
Select a record to inspect its details. Figures, CSV/TSV tables, and JSON
tables/metrics have bounded previews and an action to open the full artifact in
a JupyterLab document tab, using the file's default viewer. Opening an artifact
again reveals its existing tab. Paths, universe selection, validation, and
artifact cache tokens come from `@astra-spec/sdk`.

Inventory results show a small marker when the Lightcone engine reports them as
**Behind** (still valid, but the environment moved since) or **Stale**
(definition or input changed, hand-edited, or never materialized). Hover over it
to see the state and the reason; both are the engine's own, the ones `lc status`
prints. Current results show no extra marker. Status checks run every 15 seconds while the page is
visible and after local file changes. Engine failures clear markers and show one
message in the headbar; status returns automatically after recovery. The
integration currently covers local root-analysis outputs.

Output details also offer **Open code** beside Recipe when a local script can be
resolved from the declared recipe. It opens the current file in a reusable
editor tab. This supports direct script commands in the root analysis,
including a script named through an `{inputs.<id>}` placeholder, which resolves
to that input's declared source. Interpreter options before the script and
redirections, globs or comments after it are fine. Module, inline, and compound
commands or unresolved paths have no link. It does not restore the revision
used for an earlier run.

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

### Record tabs, versions and provenance

Results, decisions, inputs, findings and papers opened from Home, the sidebar,
search, chat cards or links open as record tabs (see
[pinning](#jupyter-ai-rich-references-and-agent-navigation) for how tabs are
reused). Following a link inside a record navigates the same tab: **Back** and
**Forward** in its toolbar (Alt+← and Alt+→ while it has focus) retrace the
path, the toolbar shows the trail
(`outputs.hubble_diagram›decisions.cosmological_model`), and coming back
restores where you had scrolled. **Open in new tab** keeps the current record
and opens it again beside it.

An output's record shows **Provenance** below Recipe as tabs: **Run** (when
it was made, the commit and Git tree it was made from, the recipe), **Code**
(the script the recipe names: **As run** shows the script at the commit the
run started from, **Changes since** its diff against the file now, and **Open
current file** opens it), **Inputs** (the recorded input versions, each
linking to its record) and **Environment** (environment, engine, uv, image,
sandbox, definition and data versions, and the packages `uv.lock` pinned for
the run with what changed in the lock since). A record tab stacks an output:
the result first, then its description and provenance below it, at every
width. **Versions** steps
through every committed version of the output file with ◀ and ▶; an older
version shows its own bytes under a banner with **Latest**. **Compare with
previous** shows images side by side, with a swipe slider or blinking between
the two, numeric deltas for JSON metrics, and row, column and header changes
for CSV/TSV tables. The history is read from the project's Git repository in
process (with [dulwich](https://www.dulwich.io/)); the bytes of an annexed
output are asked of git-annex itself (`lookupkey`, `whereis`,
`contentlocation`), so a version whose content was dropped here says which
repository still has a copy, and a clone nobody ran `git annex init` in is
never touched. Only outputs `lc materialize` made have versions, and files an
agent wrote outside `lc materialize` have no history (the ⓘ beside the
stepper says so).

**Show in pipeline**, on output and input tabs, opens the project's
**Pipeline**: its inputs and outputs as a graph colored by materialization
status, tracing the record. What the record is made from and what it feeds stay
lit, the rest dims, and a line says so in words ("made from 5 inputs and 1
output · feeds 1 output"). A record tab lists what an output depends on; only
the graph also shows what depends on it, which is what remaking it
touches. The graph takes the column beside the record (a record alone splits
to its left), so both stay in view: clicking a node traces it and opens its
record in the record's column. **Show everything** or Escape ends the trace,
and the trace is kept with the layout. The graph also opens from Home's
results line and the command palette.

### Materialization

The workbench never runs `lc materialize` itself: materializing is the agent's
job, or yours in a terminal. What it shows is the engine's own `lc status`,
read in process: each output's state (current, behind or stale) with the
engine's reason, on Home, in the sidebar, the inventory, the pipeline and
every record tab, and the last reply of a session lists the outputs whose
commits landed while the agent replied. Results show up once the engine
commits them.

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

Choose **MySTRA Viewer** in the launcher, command palette, or file-browser
context menu. Lightcone finds the nearest `myst.yml` or `myst.yaml`, starts its
MyST CLI, and opens the actual ASTRA article/book application in a tab. Opening
the same project reuses the viewer. Saved Markdown and research data changes
are handled by MyST's watcher; unsaved editor changes are not rendered.

This feature requires Node.js, the `myst` CLI, the project's MySTRA plugin, and
an ASTRA theme implementing `mystra-viewer.v1` in the **Jupyter server's**
environment. It is a MySTRA viewer, not a universal MyST theme preview. Older
ASTRA versions and stock MyST themes produce an actionable compatibility error.
The project retains its own `site.template` and plugin configuration; Lightcone
does not substitute a renderer or install MyST automatically. The first theme
launch may install its dependencies and require network access.

MyST caches downloaded themes under `_build/templates`. If an older cached
ASTRA theme renders the report but live updates or navigation fail, close its
viewer tabs and wait two minutes for the process to expire. Run
`myst clean --templates` in the project, then open the report again to fetch
the current theme. Restarting the viewer alone reuses the cache.
See [MyST’s theme update instructions](https://mystmd.org/guide/update-myst).

The tab shows status and a bounded build log during startup or on errors;
the controls disappear when the report is ready. **Restart MySTRA Viewer** in
the command palette stops and restarts the active project's process group.
Closing the tab stops its heartbeat; processes expire after two minutes
without a viewer and stop when Jupyter shuts down. **Open report** opens a new
tab after closing, reusing the process while it is still warm or starting a new
one after expiry. An expired tab explains
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

Administrators can configure `jupyter_server_config.py`:

```python
c.LightconeApp.mystra_command = ["/path/to/myst"]
c.LightconeApp.mystra_startup_timeout = 120
c.LightconeApp.mystra_idle_timeout = 120
```

The integration was validated with MyST 1.10.1 and Node.js 22/26. It requires
the companion [ASTRA theme changes](https://github.com/LightconeResearch/astra-theme/pull/16)
and the documented `mystra-viewer.v1` contract.
No separate preview domain or publicly exposed Node port is needed.

### Cited papers

Cached papers are read from `~/.cache/astra/papers`, retaining access to existing
ASTRA caches. Set `LIGHTCONE_PAPER_CACHE_DIR` in the Jupyter server environment to
use another location;
On JupyterHub this configuration belongs to each single-user server.

Missing PDFs are downloaded only when you choose **Fetch paper**, using
`astra-tools==0.2.17`. Cache lookup and download failures do not prevent viewing
the analysis. Cached PDFs are served from the authenticated Jupyter origin and
support continuous scrolling, zoom, and navigation to cited passages.

### Jupyter AI: rich references and agent navigation

Jupyter AI 3.2 (Jupyter Chat 0.25) is installed with the extension. Configure an
agent through Jupyter AI as usual. Start a [session](#sessions) from Home or the
sidebar, or, with an inventory open (or its folder selected), run **Lightcone
Agent** from the command palette or the full launcher's **Lightcone Lab ·
_project_** section. The gold chat shortcut focuses a session already open in
the project, or creates one, in the main area. Outside an ASTRA project it opens
the folder-selection and project-creation form. It sends nothing, and your
message is sent to the chat exactly as written: Lightcone adds no context text
of its own. Only pending [comments](#comments) are appended, to the prompt the
agent receives, never to the saved message.

Instead, the agent starts in the right place: its session's working directory is
the root of the chat's ASTRA project, so `lc`, `astra` and relative paths work
without naming the project. Every Jupyter AI chat has a project, however it was
opened (a Lightcone session, the Jupyter Chat sidebar's **+**, the launcher's
**Chat** item, **File › New**, or an existing `.chat` file):

1. A chat stored inside a project belongs to it: the nearest folder at or above
   the chat containing `astra.yaml`. Chats can live beside `astra.yaml` or in a
   subfolder; sessions live in `chats/`.
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

The working directory comes from a persona manager class the extension ships
for Jupyter AI's persona manager extension, selected through that extension's
own configuration file (`etc/jupyter/jupyter_jupyter_ai_persona_manager_config.json`,
installed with the wheel). A deployment that sets
`PersonaManagerExtension.persona_manager_class` in a configuration of higher
precedence (its `~/.jupyter` files, the command line) keeps its own class and
opts out of the working directory, though not of the tools' rule; subclass
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
chats and resolve the current project data in the universe each card recorded
when it was created. A card of a materialized output records the version it
showed: it keeps showing those bytes after later runs, with a chip saying a
newer version exists.
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
are outside this implementation.

See the [integration design](docs/design/jupyter-ai-integration.md) for the
compatibility boundary and future ways to simplify it.

### Appearance

Two JupyterLab themes, **Lightcone Light** and **Lightcone Dark**, restyle the
whole shell in the Lightcone brand: parchment canvas, white documents, blue-ink
actions, square corners and the brand fonts. Choose them under **Settings ›
Theme**; with **Settings › Theme › Synchronize with System Settings** they can
serve as the preferred
light and dark themes. Lightcone never switches your theme; a deployment can
make one the default in `overrides.json`:

```json
{
  "@jupyterlab/apputils-extension:themes": {
    "theme": "Lightcone Light"
  }
}
```

Under any other theme the shell stays as it is: Home and the sidebar read
JupyterLab's theme variables, and inventory components use the shared
Lightcone brand, following JupyterLab's light/dark setting. **Focus Layout** in
the command palette collapses the right sidebar and hides the status bar; run it
again to restore them.

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

Home provides JupyterLab's launcher in place of
`@jupyterlab/launcher-extension:plugin`. If launchers misbehave, check that no
other launcher replacement (such as `jupyterlab-launchpad`) is enabled; inside a
project, **Tools ▾ › Show the full launcher** shows the stock view in that tab.

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
