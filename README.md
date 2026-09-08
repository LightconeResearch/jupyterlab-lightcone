# Lightcone Lab

The open AI-assisted research workbench

**Lightcone Lab** brings a research workbench into JupyterLab, connecting
methods, evidence, and computation. The extension currently provides an ASTRA
analysis inventory, materialized outputs, and cited papers. ASTRA is the
analysis format; `astra.yaml` and its SDK contracts retain their names.

## Requirements

- Python >= 3.11
- JupyterLab >= 4.5.10, < 5
- Node.js >= 20 for extension development only

## Install

```bash
pip install jupyterlab-lightcone
```

The wheel includes the frontend, shared components, and PDF.js assets.
End users do not need Node.js or sibling source checkouts.

## Use

Open `astra.yaml` in the file browser, or select **Open With → Lightcone Lab**.
The **Lightcone Lab** launcher category and command palette also offer
**ASTRA Inventory**. The inventory is read-only: viewing preserves analysis and
result files and starts no kernel. JupyterLab may create its standard document
checkpoint when opening a writable file; the normal text editor remains
available for editing.

The inventory shows outputs, decisions, inputs, findings, prior insights, and
cited papers using the shared ASTRA components. Select an analysis or record to
inspect its details. Figures, CSV/TSV tables, and JSON tables/metrics have bounded
previews and an action to open the full artifact. Paths, universe selection,
validation, and artifact cache tokens come from `@astra-spec/sdk`.

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

### Cited papers

Cached papers are read from `~/.cache/astra/papers`, retaining access to existing
ASTRA caches. Set `LIGHTCONE_PAPER_CACHE_DIR` in the Jupyter server environment to
use another location; `ASTRA_PAPER_CACHE_DIR` remains supported as a fallback.
On JupyterHub this configuration belongs to each single-user server.

Missing PDFs are downloaded only when you choose **Fetch paper**, using
`astra-tools==0.2.13`. Cache lookup and download failures do not prevent viewing
the analysis. Cached PDFs are served from the authenticated Jupyter origin and
support continuous scrolling, zoom, and navigation to cited passages.

### Appearance

Inventory components use the shared Lightcone brand and follow JupyterLab's
light/dark theme without changing the surrounding shell.

The brand adapter from `@lightcone-research/brand` supplies every ASTRA UI
token; the extension does not redefine any of them from JupyterLab settings.
JupyterLab styles plain `button`, `a`, `select`, `code` and `pre` elements
throughout its shell, which would otherwise override the shared components'
layered styles (`style/base.css` explains the cascade). Inside the inventory
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
