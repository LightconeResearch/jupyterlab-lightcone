import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import { CustomizeWidget } from '../customize-widget';
import { fetchSetup, type ISetupReport } from '../setup-api';

jest.mock('../setup-api', () => ({ fetchSetup: jest.fn() }));
const fetch = jest.mocked(fetchSetup);

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

const PROJECT: IProjectRoot = {
  path: 'project',
  entrypoint: 'project/astra.yaml'
};

/** A settable current project. */
class FakeCurrentProject implements ICurrentProject {
  constructor(public project: IProjectRoot | null | undefined) {}
  readonly changed = new Signal<this, void>(this);
  set(project: IProjectRoot | null | undefined): void {
    this.project = project;
    this.changed.emit();
  }
}

/** A theme manager whose theme the test sets and announces. */
class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Dark', 'JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = (name: string) => name.endsWith('Light');
  getDisplayName = (name: string) => name;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = jest.fn(async (_name: string) => undefined);
  register = () => new DisposableDelegate(() => undefined);
  apply(theme: string): void {
    const oldValue = this.theme;
    this.theme = theme;
    this.themeChanged.emit({ name: 'theme', oldValue, newValue: theme });
  }
}

/** JupyterLab's `ThemeManager`, which can follow the system color scheme. */
class FakeAdaptiveThemeManager extends FakeThemeManager {
  adaptive = true;
  isToggledAdaptiveTheme = () => this.adaptive;
  toggleAdaptiveTheme = jest.fn(async () => {
    this.adaptive = !this.adaptive;
  });
}

/** Poll until `predicate` holds, failing after `timeout` ms. */
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for a condition.');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function host(
  options: {
    project?: IProjectRoot | null | undefined;
    themes?: FakeThemeManager;
  } = {}
) {
  const commands = new CommandRegistry();
  const open = jest.fn();
  const changeTheme = jest.fn();
  commands.addCommand('docmanager:open', { execute: open });
  commands.addCommand('apputils:change-theme', { execute: changeTheme });
  const current = new FakeCurrentProject(
    'project' in options ? options.project : PROJECT
  );
  const themes = options.themes ?? new FakeThemeManager();
  const widget = new CustomizeWidget({
    settings: ServerConnection.makeSettings(),
    current,
    themes,
    commands
  });
  widget.id = 'lightcone-customize';
  Widget.attach(widget, document.body);
  const text = () => widget.node.textContent ?? '';
  const button = (label: string) =>
    Array.from(widget.node.querySelectorAll('button')).find(
      candidate => candidate.textContent === label
    );
  const click = (label: string) => {
    const element = button(label);
    if (!element) {
      throw new Error(`No ${label} button.`);
    }
    element.click();
  };
  const select = () => {
    const element = widget.node.querySelector('select');
    if (!element) {
      throw new Error('The Appearance section has no theme picker.');
    }
    return element;
  };
  return {
    widget,
    current,
    themes,
    open,
    changeTheme,
    text,
    button,
    click,
    select,
    dispose: () => widget.dispose()
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  fetch.mockResolvedValue(report);
});

it('checks the current project and again when the user browses to another', async () => {
  const h = host();
  try {
    await until(() => h.text().includes('Everything Lightcone needs'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toBe('project/astra.yaml');
    expect(h.text()).toContain('Project project');
    expect(h.text()).toContain('Claude Code');
    h.current.set({ path: 'other', entrypoint: 'other/astra.yaml' });
    await until(() => h.text().includes('Project other'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toBe('other/astra.yaml');
    h.current.set(null);
    await until(() => h.text().includes('No Lightcone project'));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1]).toBeUndefined();
  } finally {
    h.dispose();
  }
});

it('drops the previous project’s rows while the next project is checked', async () => {
  const h = host();
  try {
    await until(() => h.text().includes('project/AGENTS.md'));
    const pending = new PromiseDelegate<ISetupReport>();
    fetch.mockReturnValueOnce(pending.promise);
    h.current.set({ path: 'other', entrypoint: 'other/astra.yaml' });
    await until(() => h.text().includes('Checking what is installed'));
    expect(h.text()).toContain('Project other');
    expect(h.text()).not.toContain('project/AGENTS.md');
    expect(h.text()).not.toContain('Claude Code');
    expect(h.button('Edit')).toBeUndefined();
    expect(h.widget.report).toBeUndefined();
    pending.resolve({
      ...report,
      instructions: { path: 'other/AGENTS.md', exists: true }
    });
    await until(() => h.text().includes('other/AGENTS.md'));
    h.click('Edit');
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'other/AGENTS.md' })
    );
  } finally {
    h.dispose();
  }
});

it('waits for the project lookup before saying there is no project', async () => {
  const h = host({ project: undefined });
  try {
    await until(() => h.text().includes('Claude Code'));
    expect(h.text()).toContain('Looking for a project');
    expect(h.text()).not.toContain('No Lightcone project');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toBeUndefined();
    // Outside every project the server is asked the same question: no recheck.
    h.current.set(null);
    await until(() => h.text().includes('No Lightcone project'));
    expect(h.text()).toContain('Claude Code');
    expect(fetch).toHaveBeenCalledTimes(1);
    h.current.set(PROJECT);
    await until(() => h.text().includes('Project project'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toBe('project/astra.yaml');
  } finally {
    h.dispose();
  }
});

it('opens the project instructions right after the settings tab', async () => {
  const h = host();
  try {
    await until(() => h.button('Edit') !== undefined);
    h.click('Edit');
    expect(h.open).toHaveBeenCalledWith({
      path: 'project/AGENTS.md',
      options: { mode: 'tab-after', ref: 'lightcone-customize' }
    });
  } finally {
    h.dispose();
  }
});

it('switches the theme through the theme command and follows the Lab theme', async () => {
  const h = host();
  try {
    await until(() => h.widget.node.querySelector('select') !== null);
    expect(h.select().value).toBe('JupyterLab Light');
    expect(
      Array.from(h.widget.node.querySelectorAll('optgroup')).map(
        group => group.label
      )
    ).toEqual(['Light', 'Dark']);
    h.select().value = 'JupyterLab Dark';
    h.select().dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => h.changeTheme.mock.calls.length > 0);
    expect(h.changeTheme).toHaveBeenCalledWith({ theme: 'JupyterLab Dark' });
    expect(h.themes.setTheme).not.toHaveBeenCalled();
    // The picker shows the theme Lab applies, so it moves once Lab applies it.
    expect(h.select().value).toBe('JupyterLab Light');
    h.themes.apply('JupyterLab Dark');
    await until(() => h.select().value === 'JupyterLab Dark');
  } finally {
    h.dispose();
  }
});

it('applies the picked theme when the theme follows the system', async () => {
  const themes = new FakeAdaptiveThemeManager();
  const h = host({ themes });
  try {
    await until(() => h.widget.node.querySelector('select') !== null);
    h.select().value = 'JupyterLab Dark';
    h.select().dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => themes.toggleAdaptiveTheme.mock.calls.length > 0);
    // The picked theme is stored before syncing stops, so it is the one applied.
    expect(themes.setTheme).toHaveBeenCalledWith('JupyterLab Dark');
    expect(themes.setTheme.mock.invocationCallOrder[0]).toBeLessThan(
      themes.toggleAdaptiveTheme.mock.invocationCallOrder[0]
    );
    expect(themes.adaptive).toBe(false);
    expect(h.changeTheme).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('keeps the last report when a refresh fails, and drops it for another project', async () => {
  const h = host();
  try {
    await until(() => h.text().includes('Claude Code'));
    fetch.mockRejectedValueOnce(new Error('Setup request failed (503)'));
    h.click('Refresh');
    await until(() => h.text().includes('Setup request failed (503)'));
    expect(h.text()).toContain('Claude Code');
    fetch.mockRejectedValueOnce(new Error('Setup request failed (404)'));
    h.current.set({ path: 'gone', entrypoint: 'gone/astra.yaml' });
    await until(() => h.text().includes('Setup request failed (404)'));
    expect(h.text()).not.toContain('Claude Code');
    expect(h.text()).not.toContain('Checked at');
    expect(h.widget.report).toBeUndefined();
  } finally {
    h.dispose();
  }
});
