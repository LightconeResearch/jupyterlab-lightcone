# Lightcone Lab

[![License](https://img.shields.io/badge/License-BSD_3--Clause-426b78.svg?style=flat)](https://opensource.org/licenses/BSD-3-Clause)
[![Python](https://img.shields.io/badge/python-3.11%20%7C%203.12%20%7C%203.13%20%7C%203.14-4e5a70?style=flat)](https://pypi.org/project/jupyterlab-lightcone/)
[![JupyterLab](https://img.shields.io/badge/JupyterLab-4.5-f37626?style=flat)](https://jupyterlab.readthedocs.io/)
[![PyPI](https://img.shields.io/pypi/v/jupyterlab-lightcone?style=flat&color=f8f7f3)](https://pypi.org/project/jupyterlab-lightcone/)

**Lightcone Lab** is the open, AI-assisted research workbench for JupyterLab.
It turns an [ASTRA](https://astra-spec.org/latest/) project into a place to
work: explore your analysis, trace every result back to the run that made it,
and research alongside an AI agent that knows your project, with
[lightcone-cli](https://pypi.org/project/lightcone-cli/) handling execution
and provenance underneath.

## Install

Lightcone Lab comes in two installs. Add it to the Python environment that
runs JupyterLab, for example from JupyterLab's own terminal
(**File › New › Terminal**), then restart JupyterLab.

**Full**, for a JupyterLab you run yourself, with Jupyter AI and the Lightcone
engine:

```bash
pip install "jupyterlab-lightcone[full]"
```

It needs JupyterLab ≥ 4.5.10 (< 5) and Python ≥ 3.11 on a Linux or macOS
server, with `git` and
[`uv`](https://docs.astral.sh/uv/getting-started/installation/) on the server's
`PATH`.

**Workbench only**, for a JupyterLab you cannot configure, such as a JupyterHub
at a computing center:

```bash
pip install --user jupyterlab-lightcone
```

This installs the prebuilt frontend and nothing the server runs. On Linux it
lands in `~/.local/share/jupyter/labextensions`, where JupyterLab (≥ 4.5.10)
looks for your own extensions; restart your server to load it (on JupyterHub,
**File › Hub Control Panel › Stop My Server**, then start it again). The
workbench runs in the browser on JupyterLab's own file and terminal services;
[Features](#features) lists what needs the full install. To run `lc` in its
terminals, install [lightcone-cli](https://pypi.org/project/lightcone-cli/) in
an environment they can use.

### Add an agent

On the workbench alone, agents run in a terminal: the **claude** and **codex**
buttons on a project's Home start
[Claude Code](https://code.claude.com/docs/en/setup) or
[Codex](https://developers.openai.com/codex/cli) in a terminal beside it, in the
project folder. Install and sign in to them where the server's terminals run.

The full install also works with the coding agents Jupyter AI connects to, but
none comes bundled. Install at least one on the server, sign in, add its adapter
and restart JupyterLab; the agent then appears in the picker.

| Agent  | Install and sign in                                                          | Adapter (Node.js ≥ 22)                                 |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude | [Claude Code](https://code.claude.com/docs/en/setup), then run `claude` once | `npm install -g @agentclientprotocol/claude-agent-acp` |
| Codex  | [Codex CLI](https://developers.openai.com/codex/cli), then `codex login`     | `npm install -g @agentclientprotocol/codex-acp`        |

## Get started

1. Choose **New Lightcone project** in the launcher, or browse into any folder
   holding an `astra.yaml`. On the workbench alone, setup runs `lc init` in a
   terminal beside the form, and the project opens once it is done.
2. The launcher becomes the project's **Home**: pick an agent, describe what you
   want to do, and press **Start**; on the workbench alone, choose **claude**
   or **codex** to start one in a terminal beside Home.
3. Open results and let the agent iterate. Lightcone keeps track of what
   changed.

→ [Learn about ASTRA and `lc`](https://docs.lightconeresearch.org)

## Features

Both installs:

- **Project Home**: title, description and latest results in every launcher
  tab inside a project, with a terminal in the project folder one click away
- **ASTRA inventory**: outputs, decisions, inputs, findings and cited papers,
  with figure and table previews
- **Pipeline**: trace what feeds a result and what depends on it
- **Papers**: read cited arXiv papers in place, straight from arXiv
- **Search**: <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> across records, files
  and commands
- **Lightcone themes**: optional **Lightcone Light** and **Lightcone Dark**
  themes, and a distraction-free **Focus Layout**

The full install adds:

- **Project-aware agents**: Jupyter AI sessions start at the project root,
  show results as rich cards, and list what each reply changed; Home starts
  them and lists the recent ones, and search finds them
- **Freshness**: each result's `lc status`, live in the inventory
- **Provenance**: the code, inputs and locked environment behind each result;
  browse committed versions and compare them side by side
- **Comments**: pin notes on figures, text, papers and messages; they reach
  the agent with your next message, and `@` and `#` reference records and
  sessions in the composer
- **Paper cache and reports**: fetch any cited paper into the ASTRA cache, and
  preview the project's MyST report (needs Node.js ≥ 20 on the server)
- **Project setup** by the server, without a terminal

## License

BSD 3-Clause
