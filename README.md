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

Add Lightcone Lab to the Python environment that runs JupyterLab, for example
from JupyterLab's own terminal (**File › New › Terminal**), then restart
JupyterLab:

```bash
pip install jupyterlab-lightcone
```

Jupyter AI and the Lightcone engine come with it. It needs JupyterLab ≥ 4.5.10
(< 5) and Python ≥ 3.11 on a Linux or macOS server, with `git` and
[`uv`](https://docs.astral.sh/uv/getting-started/installation/) on the server's
`PATH`.

### Add an agent

Lightcone Lab works with the coding agents Jupyter AI connects to, but none
comes bundled. Install at least one on the server, sign in, add its adapter and
restart JupyterLab; the agent then appears in the picker.

| Agent  | Install and sign in                                                          | Adapter (Node.js ≥ 22)                                 |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude | [Claude Code](https://code.claude.com/docs/en/setup), then run `claude` once | `npm install -g @agentclientprotocol/claude-agent-acp` |
| Codex  | [Codex CLI](https://developers.openai.com/codex/cli), then `codex login`     | `npm install -g @agentclientprotocol/codex-acp`        |

Copilot, Goose, Kilo, Kiro, Mistral Vibe and OpenCode work too: see
[Jupyter AI's agent guide](https://jupyter-ai.readthedocs.io/en/stable/getting-started.html#install-agents).

## Get started

1. Choose **New Lightcone project** in the launcher, or browse into any folder
   holding an `astra.yaml`.
2. The launcher becomes the project's **Home**: pick an agent, describe what you
   want to do, and press **Start**.
3. Open results, comment on them, and let the agent iterate. Lightcone keeps
   track of what changed.

→ [Learn about ASTRA and `lc`](https://docs.lightconeresearch.org)

## Features

- **Project Home**: title, description, latest results and recent sessions,
  in every launcher tab inside a project
- **ASTRA inventory**: outputs, decisions, inputs, findings and cited papers,
  with figure and table previews and live freshness status
- **Provenance**: the code, inputs and locked environment behind each result;
  browse committed versions and compare them side by side
- **Pipeline**: trace what feeds a result and what depends on it
- **Project-aware agents**: Jupyter AI sessions start at the project root,
  show results as rich cards, and list what each reply changed
- **Comments**: pin notes on figures, text, papers and messages; they reach
  the agent with your next message
- **Search**: <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> across sessions,
  records, files and commands; `@` and `#` reference them in the composer
- **Papers and reports**: read cited papers in place, fetch missing ones, and
  preview the project's MyST report (needs Node.js ≥ 20 on the server)
- **Lightcone themes**: optional **Lightcone Light** and **Lightcone Dark**
  themes, and a distraction-free **Focus Layout**

## License

BSD 3-Clause
