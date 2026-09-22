# Lightcone Lab

The open AI-assisted research workbench

**Lightcone Lab** brings a research workbench into JupyterLab, connecting
methods, evidence, and computation. The extension currently provides an ASTRA
analysis inventory, materialized outputs, and cited papers. ASTRA is the
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

Outside a project, the Lightcone Lab launcher shows **＋ Create project** and
**Open project**. Inside a project or its subfolders, it shows the
inventory and report. The launcher heading identifies the project root.
Project detection uses the nearest enclosing `astra.yaml` on the current Jupyter
Contents drive and is independent of file-browser filters. A nested project
uses its own root.
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
project launcher opens. Choose the inventory or viewer from the launcher.
Inventory commands invoked in a folder without `astra.yaml` offer the same
setup form.

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

While a project is open in an inventory or record view, a small JupyterLab
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

### Record tabs

Open an ASTRA element as a native tab from other UI integrations:

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
the native tab title, or use **Pin ASTRA tab**
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

The shared rendering contract uses published `@astra-spec/ui` 0.0.5 and
`@lightcone-research/brand` 0.0.3, installed from npm.
