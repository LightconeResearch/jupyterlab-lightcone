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

Outside a project, the Lightcone Lab launcher shows **＋ Create project** and
**Open project**. Inside a project or its subfolders, it shows the agent,
inventory, and report. The launcher heading identifies the project root.
Browse labels folders containing `astra.yaml` as **ASTRA project**; this indicates
presence, not validation of the specification.

Choose **Create project** in the launcher (or command palette), enter a project
folder, or use **Browse…** to select an existing directory. Create defaults to a
new `my-project` subfolder, which you can rename. Paths are relative to
the Jupyter server's root; absolute paths inside that root are also accepted.
Existing projects open directly. For a folder without `astra.yaml`, **Create
project here** initializes the exact folder shown, as `lc init` would. Inspecting
or cancelling the form creates nothing. The extension installs `lightcone-cli` as
a dependency and calls its engine directly, so no `lc` command has to be on the
server's `PATH`. Initialization requires a local filesystem server, and the
engine's own tools, `uv` and `git`, on the server's `PATH`; failures are
displayed in the form and can be retried. After closing the form or
reloading JupyterLab, run **Finish project setup** from the command palette to
resume setup, including when `astra.yaml` already exists. The Create form also
offers **Finish setup…** after inspecting an existing project. Both routes show
the exact destination before running initialization; file presence alone does
not imply setup completed. Each setup action opens a fresh form so an older
draft cannot override a newly selected destination.

After opening or creating a project, the file browser navigates there and the
project launcher opens. Choose the agent, inventory, or viewer from the launcher.
Choosing Lightcone Agent creates its chat file inside the project, which is also
the working directory used by Jupyter AI's ACP client. Select a configured persona
in Jupyter AI to start messaging; opening the chat does not send a message.
Inventory and Lightcone Agent commands invoked in a folder without `astra.yaml`
offer the same setup form.

Open `astra.yaml` in the file browser, or select **Open With → Lightcone Lab**.
The **Lightcone Lab** launcher category and command palette also offer
**ASTRA Inventory**. The inventory is read-only: viewing preserves analysis and
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
revision. **Details** opens the recorded recipe, input versions, environment, and
Lightcone version without leaving the result.

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
chats and resolve the current project data in the universe each card recorded
when it was created.
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
the preview tool instead. Full MyST documents, block/value/citation roles,
and historical result snapshots are outside this implementation.

See the [integration design](docs/design/jupyter-ai-integration.md) for the
compatibility boundary and future ways to simplify it.

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
