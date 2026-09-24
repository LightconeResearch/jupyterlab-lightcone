# Lightcone Lab

The open AI-assisted research workbench

**Lightcone Lab** brings a research workbench into JupyterLab, connecting
methods, evidence, and computation. Inside a project it provides a
[Home](#home) page, a [project sidebar](#lightcone-sidebar), agent
[sessions](#sessions), [record tabs with result versions and
provenance](#record-tabs-versions-and-provenance), [runs](#runs),
[comments](#comments), [search](#search), a [settings page](#lightcone-settings)
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
`uv` and `git`, on the server's `PATH`; failures are displayed in the form and
can be retried. After closing the form or reloading JupyterLab, run **Finish
project setup** from the command palette to resume setup, including when
`astra.yaml` already exists; file presence alone does not imply setup
completed. While setup runs, the form shows the exact destination. Each setup
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

The left column shows the project's name, a line of badges counting what the
ASTRA analysis holds (results, decisions, inputs, findings, papers, each with
the kind mark the inventory uses), and its description. Below them, **Open
report** (only when the project has a `myst.yml` or `myst.yaml`; it opens the
[MySTRA Viewer](#mystra-viewer)) and **Open ASTRA**, which opens the ASTRA
inventory. Result plates follow under one freshness line, with **Pipeline**
(the graph behind that line, see [record tabs](#record-tabs-versions-and-provenance)) and **See all**
leading to the inventory.
When results are stale the freshness line names them and **Rematerialize stale
(N)** (or **Refresh behind (N)** when they only lag the environment) starts
`lc materialize` for them and opens [Runs](#runs) to follow it. The right
column is the desk: a composer with an agent picker and **Start**, then recent
sessions with a working or needs-input marker. **Start** is the only action on
Home that sends a message. Home reads JupyterLab's theme variables, so it looks
native under any theme; showing it starts no kernel, MyST or recipe.

The extension replaces `@jupyterlab/launcher-extension:plugin` through
`disabledExtensions` in its `package.json`. Disabling Lightcone Lab
(`jupyter labextension disable jupyterlab-lightcone`) restores the stock
launcher. Other launcher replacements, such as `jupyterlab-launchpad` or
Elyra's, conflict with it.

### Lightcone sidebar

The Lightcone icon in the left sidebar (or **Show Lightcone Sidebar** in the
command palette) opens the project's navigation: its name with a project
switcher (▾) and a Home button, **New session**, **Search**, the sessions
(renamable, with activity markers), results with their materialization status
and **Rematerialize stale (N)**, the analysis tree with record counts, where
runs execute ([Compute](#compute)), the number of pending
[comments](#comments), and links to **Files**, **Report** and
[**Runs**](#runs). The switcher lists recently visited projects and the other
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
file. Creating a session also creates `chats/` if needed and adds the
project's `chats/` folder and `.chat` files to the repository's local
`.git/info/exclude` (never to `.gitignore`), so chats stay out of the
project's Git status and `lc materialize` still runs. Results opened from a
session split to its right, later results join that group, and closing them
returns focus to the session. A session that finishes, or asks for
permission, while you look elsewhere raises a notification with **Open
session**, and while its agent works it is listed under **Lightcone** in
JupyterLab's Running panel. An empty session shows the project name and "What
would you like to explore?".

A session's toolbar states the agent's permission mode as Jupyter AI records
it (for example "Codex: agent full access") and that the engine's sandbox
covers only what `lc run` and `lc materialize` execute: it does not confine the
agent's own shell. In the composer, `@` completes the project's records
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
resolved. It opens the current file in a reusable editor tab, preferring the
command from the recorded run over the declared recipe; the link's tooltip
names which one applied. This supports direct script commands in the root
analysis, including a script named through an `{inputs.<id>}` placeholder,
which resolves to that input's declared source. Interpreter options before the
script and redirections, globs or comments after it are fine. Module, inline,
and compound commands or unresolved paths have no link, and neither does an
output whose run record cannot be read. It does not restore the revision used
for an earlier run.

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

An output's record shows **Provenance** below Recipe as tabs: **Run** (status,
times, command, exit code, commit and Git tree), **Code** (the recorded command
and the script it names: **As run** shows the script at the commit the run
started from, **Changes since** its diff against the file now, and **Open
current file** opens it), **Inputs** (the recorded input versions, each
linking to its record), **Environment** (environment, engine, uv, image,
sandbox, definition and data versions, and the packages `uv.lock` pinned for
the run with what changed in the lock since) and **Conversation** (sessions
active around the run, matched by time, so a heuristic). **Versions** steps
through every committed version of the output file with ◀ and ▶; an older
version shows its own bytes under a banner with **Latest**, and content missing
from the local annex says so. **Compare with previous** shows images side by
side, with a swipe slider or blinking between the two, numeric deltas for JSON
metrics, and row, column and header changes for CSV/TSV tables. Only outputs
`lc materialize` made have versions; older bytes last only while git-annex
keeps their content, and files an agent wrote outside `lc materialize` have no
history (the ⓘ beside the stepper says so).

**Show in pipeline**, on output and input tabs, opens the project's
**Pipeline**: its inputs and outputs as a graph colored by materialization
status, tracing the record. What the record is made from and what it feeds stay
lit, the rest dims, and a line says so in words ("made from 5 inputs and 1
output · feeds 1 output"). A record tab lists what an output depends on; only
the graph also shows what depends on it, which is what rematerializing it
touches. The graph takes the column beside the record (a record alone splits
to its left), so both stay in view: clicking a node traces it and opens its
record in the record's column. **Show everything** or Escape ends the trace,
and the trace is kept with the layout. The graph also opens from Home's
results line and the command palette.

### Runs

**Runs** (sidebar footer or command palette) lists the project's
materialization jobs started from JupyterLab, with their live log and **Stop**,
the outputs that are stale or behind with actions to rematerialize them, and the
run history recorded in Git, by day, with the outputs one `lc materialize` made
grouped together; a run opens its output at the version it made. **Materialize**
in its toolbar, or **Materialize outputs** in the command palette, runs the
engine's `materialize` in the project on the Jupyter server; Home and the
sidebar start the same job for stale results. One job runs per project at a
time; the engine's refusals (a dirty tree, a login node, a missing committer)
are shown as it prints them. Runs says where recipes execute (this host, or the
SLURM allocation the server runs in, with its node count) and, when
`jupyter-resource-usage` is installed, the server's memory and CPU use. Running
jobs, and sessions whose agent is working, appear under **Lightcone** in
JupyterLab's Running panel; **Stop All** there stops materializations only. A
`lc materialize` an agent starts in its own shell is not followed; it appears
in the history once it commits. Materializing executes the project's recipes
as the server user: an authorizer must permit `execute` on the `lightcone`
resource and `write` on `contents`.

### Compute

The sidebar's **Compute** section lists where the project's runs can execute:
this host (**This machine**, **This server** on JupyterHub, **Login node**, or
**This allocation** inside a Slurm job) and the Dask clusters you started. The
one `lc materialize` uses carries the active bar, with its load, its expected
start, or what stops it. **New cluster** starts one from a preset: a local
scheduler and worker on this host, one Slurm job (a scheduler on its first node
and a worker on each node), or a Dask Gateway cluster on a JupyterHub. Each
cluster's **⋯** menu opens its dashboard (through `jupyter-server-proxy`, when
installed with `bokeh`) and stops it; a cluster that ends on its own (time
limit, idle timeout) is reported as a notification. Clusters belong to you, not
to a project, and every cluster is authenticated with its own TLS key.

Clusters are recorded under `~/.lightcone/clusters/`, where `lc materialize`
finds them from any terminal or agent; `lightcone-cli` releases that read these
records attach to the cluster instead of starting their own, and until then the
section says runs stay on this host. Presets are the `jupyterlab-lightcone:compute`
settings, which a site ships in `overrides.json`, for example on NERSC
Perlmutter:

```json
{
  "jupyterlab-lightcone:compute": {
    "presets": [
      {
        "label": "Debug · 1 node · 30 min",
        "backend": "slurm",
        "nodes": 1,
        "time": "30",
        "qos": "debug",
        "constraint": "cpu"
      },
      {
        "label": "Regular · 4 nodes · 2 h",
        "backend": "slurm",
        "nodes": 4,
        "time": "2:00:00",
        "qos": "regular",
        "constraint": "cpu"
      }
    ]
  }
}
```

Gateway presets take `workers` (the adaptive maximum), `cores` and `memory`;
local presets take `threads`. **New cluster › Custom…** starts a one-off size
and can save it as a preset. Local and Slurm schedulers stop after 30 idle
minutes (`c.LightconeApp.cluster_idle_timeout`, in seconds). Starting and
stopping clusters needs `execute` on the `lightcone` resource. The design, and
the contract with `lightcone-cli`, are in
[docs/design/compute-clusters.md](docs/design/compute-clusters.md).

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

### Lightcone settings

**Lightcone Settings** in the command palette opens one page of the actual
setup. **Agents**: for Claude and Codex, whether Jupyter AI's ACP client is
installed, the adapter executable is found, Jupyter AI discovered the persona
(it loads personas once, so an adapter installed later needs a server restart)
and credentials are found, each reported on its own. **Skills**: the Lightcone
and ASTRA skills installed for each harness, with their version. **Project
instructions**: the project's `AGENTS.md` or `CLAUDE.md` (**Edit** opens it).
**Environment**: whether `uv.lock` matches `pyproject.toml` and `.venv` matches
the lock (as `lc status` checks them), and **Register project kernel**, which
installs a user kernel spec (`lightcone-<folder>`) running notebooks in the
project's `.venv`; it needs `ipykernel` declared in the project (`uv add --dev
ipykernel`) and `execute` on `lightcone`. **Tools** the engine uses.
**Execution boundary**: the sandbox, the container runtime and image, and
whether the server runs in a SLURM allocation. **Storage**: the project's
git-annex, its remotes and how many annexed results lack their content here.
**Appearance**: the theme. **Refresh** checks again.

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

The tab shows status and a bounded build log during startup or on errors;
the controls disappear when the report is ready. **Restart MySTRA Viewer** in
the command palette stops and restarts the active project's process group.
Closing the tab stops its heartbeat; processes expire after two minutes
without a viewer and stop when Jupyter shuts down. An expired tab explains
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
use another location; `ASTRA_PAPER_CACHE_DIR` remains supported as a fallback.
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
Theme** or in [Lightcone settings](#lightcone-settings); with **Settings ›
Theme › Synchronize with System Settings** they can serve as the preferred
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
