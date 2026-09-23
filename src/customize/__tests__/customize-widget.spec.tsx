import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { IThemeManager } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import { CustomizeWidget } from '../customize-widget';
import { fetchSetup, type ISetupReport } from '../setup-api';

jest.mock('../setup-api', () => ({ fetchSetup: jest.fn() }));
const fetch = jest.mocked(fetchSetup);

// React 18 warns about `act` unless the environment declares support for it.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const report: ISetupReport = {
  jupyterAi: true,
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      executable: {
        name: 'claude-agent-acp',
        found: true,
        path: '/usr/bin/claude-agent-acp'
      }
    }
  ],
  skills: [],
  tools: {
    uv: { found: true, path: '/usr/bin/uv', version: '0.8.0' },
    git: { found: true, path: '/usr/bin/git', version: '2.51.0' },
    'git-annex': { found: true, path: '/usr/bin/git-annex', version: null },
    myst: { found: true, path: '/usr/bin/myst', version: '1.6.0' }
  },
  sandbox: { backend: 'landlock', available: true },
  environment: { lock: true, venv: true },
  instructions: { path: 'project/AGENTS.md', exists: true },
  storage: { annex: true, remotes: [] }
};

class CurrentProjectStub implements ICurrentProject {
  project: IProjectRoot | null | undefined = {
    path: 'project',
    entrypoint: 'project/astra.yaml'
  };
  readonly changed: Signal<ICurrentProject, void> = new Signal<
    ICurrentProject,
    void
  >(this);
}

function host() {
  const commands = new CommandRegistry();
  const open = jest.fn();
  const changeTheme = jest.fn();
  commands.addCommand('docmanager:open', { execute: open });
  commands.addCommand('apputils:change-theme', { execute: changeTheme });
  const current = new CurrentProjectStub();
  const themeChanged = new Signal<IThemeManager, unknown>({} as IThemeManager);
  const themes = {
    theme: 'JupyterLab Light',
    themes: ['JupyterLab Dark', 'JupyterLab Light'],
    getDisplayName: (name: string) => name,
    isLight: (name: string) => name.endsWith('Light'),
    themeChanged,
    setTheme: jest.fn()
  } as unknown as IThemeManager;
  const widget = new CustomizeWidget({
    settings: ServerConnection.makeSettings(),
    current,
    themes,
    commands
  });
  widget.id = 'lightcone-customize';
  const node = document.createElement('div');
  let root: Root | undefined;
  const render = async () => {
    // The widget re-renders its own node through Lumino's message loop.
    await act(async () => {
      await flush();
    });
    root ??= createRoot(node);
    await act(async () => root!.render(widget.render()));
  };
  return {
    widget,
    node,
    current,
    open,
    changeTheme,
    render,
    dispose: () => {
      act(() => root?.unmount());
      widget.dispose();
    }
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  fetch.mockResolvedValue(report);
});

it('checks the current project and again when the user browses to another', async () => {
  const h = host();
  try {
    await h.render();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toBe('project/astra.yaml');
    expect(h.node.textContent).toContain('Project project');
    expect(h.node.textContent).toContain('Claude Code');
    expect(h.node.textContent).toContain('Everything Lightcone needs');
    h.current.project = { path: 'other', entrypoint: 'other/astra.yaml' };
    h.current.changed.emit();
    await h.render();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toBe('other/astra.yaml');
    expect(h.node.textContent).toContain('Project other');
    h.current.project = null;
    h.current.changed.emit();
    await h.render();
    expect(fetch.mock.calls[2][1]).toBeUndefined();
    expect(h.node.textContent).toContain('No Lightcone project');
  } finally {
    h.dispose();
  }
});

it('opens the project instructions right after the settings tab', async () => {
  const h = host();
  try {
    await h.render();
    const edit = Array.from(h.node.querySelectorAll('button')).find(
      button => button.textContent === 'Edit'
    );
    expect(edit).toBeDefined();
    await act(async () => edit!.click());
    expect(h.open).toHaveBeenCalledWith({
      path: 'project/AGENTS.md',
      options: { mode: 'tab-after', ref: 'lightcone-customize' }
    });
  } finally {
    h.dispose();
  }
});

it('switches the theme through the theme command', async () => {
  const h = host();
  try {
    await h.render();
    const select = h.node.querySelector('select');
    expect(select?.value).toBe('JupyterLab Light');
    expect(
      Array.from(h.node.querySelectorAll('optgroup')).map(group => group.label)
    ).toEqual(['Light', 'Dark']);
    await act(async () => {
      select!.value = 'JupyterLab Dark';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(h.changeTheme).toHaveBeenCalledWith({ theme: 'JupyterLab Dark' });
  } finally {
    h.dispose();
  }
});

it('keeps the last report when a refresh fails, and drops it for another project', async () => {
  const h = host();
  try {
    await h.render();
    fetch.mockRejectedValueOnce(new Error('Setup request failed (503)'));
    const refresh = Array.from(h.node.querySelectorAll('button')).find(
      button => button.textContent === 'Refresh'
    );
    await act(async () => refresh!.click());
    await h.render();
    expect(h.node.textContent).toContain('Setup request failed (503)');
    expect(h.node.textContent).toContain('Claude Code');
    fetch.mockRejectedValueOnce(new Error('Setup request failed (404)'));
    h.current.project = { path: 'gone', entrypoint: 'gone/astra.yaml' };
    h.current.changed.emit();
    await h.render();
    expect(h.node.textContent).toContain('Setup request failed (404)');
    expect(h.node.textContent).not.toContain('Claude Code');
    expect(h.widget.report).toBeUndefined();
  } finally {
    h.dispose();
  }
});
