import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { IThemeManager } from '@jupyterlab/apputils';
import { LauncherModel } from '@jupyterlab/launcher';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { HomeWidget } from '../home-widget';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../api', () => ({
  ...jest.requireActual('../../api'),
  collectPaperMetadata: jest.fn().mockResolvedValue({}),
  fetchPaper: jest.fn()
}));
jest.mock('../../materialization-status', () => ({
  useMaterializationStatus: () => ({}),
  outputMaterializationStatus: () => undefined
}));
jest.mock('../../runs/runs-api', () => ({
  listRuns: jest.fn().mockResolvedValue({ runs: [], jobs: [] })
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition instead of a fixed delay. */
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for the Home widget.');
    }
    await flush();
  }
}

function host() {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(analysis('Union 2.1 cosmology')),
    'project/myst.yml': fileModel('site: {}'),
    'project/data/readme.txt': fileModel('hello'),
    'elsewhere/notes.txt': fileModel('notes')
  });
  const commands = new CommandRegistry();
  const themes = {
    theme: 'JupyterLab Light',
    isLight: () => true,
    themeChanged: new Signal<object, void>({})
  } as unknown as IThemeManager;
  const changed = new Signal<ICurrentProject, void>(
    {} as unknown as ICurrentProject
  );
  const current = { project: undefined, changed } as unknown as ICurrentProject;
  const shell = {
    widgets: () => [][Symbol.iterator](),
    activateById: jest.fn(),
    currentWidget: null
  } as unknown as JupyterFrontEnd.IShell;
  const onOpenTools = jest.fn();
  const widget = new HomeWidget({
    model: new LauncherModel(),
    cwd: 'elsewhere',
    commands,
    contents,
    shell,
    themes,
    current,
    callback: jest.fn(),
    onOpenTools
  });
  Widget.attach(widget, document.body);
  const bodies = () => ({
    launcher: !widget.node
      .querySelector('.jp-jupyterlab-lightcone-Home-launcher')
      ?.classList.contains('lm-mod-hidden'),
    view: !widget.node
      .querySelector('.jp-jupyterlab-lightcone-HomeView')
      ?.classList.contains('lm-mod-hidden'),
    stockBar: !widget.node
      .querySelector('.jp-jupyterlab-lightcone-Home-stockBar')
      ?.classList.contains('lm-mod-hidden')
  });
  return {
    widget,
    contents,
    changed,
    onOpenTools,
    bodies,
    dispose: () => {
      widget.dispose();
      contents.dispose();
    }
  };
}

it('shows the stock launcher outside a project and Home inside one', async () => {
  const h = host();
  try {
    await until(() => h.widget.project === null);
    expect(h.widget.mode).toBe('stock');
    expect(h.widget.title.label).toBe('Launcher');
    expect(h.bodies()).toEqual({
      launcher: true,
      view: false,
      stockBar: false
    });

    h.widget.cwd = 'project/data';
    await until(() => h.widget.project?.entrypoint === 'project/astra.yaml');
    expect(h.widget.mode).toBe('home');
    expect(h.widget.title.label).toBe('Home');
    expect(h.widget.title.caption).toBe('Lightcone Lab · project');
    expect(h.bodies()).toEqual({
      launcher: false,
      view: true,
      stockBar: false
    });

    // The page renders from the project's own data, with no results yet.
    await until(() =>
      h.widget.node.textContent!.includes('Union 2.1 cosmology')
    );
    const text = h.widget.node.textContent!;
    expect(text).toContain('Lightcone Lab');
    expect(text).toContain('No results yet');
    expect(text).toContain('Open report');
    expect(text).toContain('0 decisions');
    // No sessions service: no desk, no composer.
    expect(text).not.toContain('New session');

    const tools = h.widget.node.querySelector<HTMLButtonElement>(
      '.jp-jupyterlab-lightcone-Home-tools'
    );
    tools!.click();
    expect(h.onOpenTools).toHaveBeenCalledWith(tools);
  } finally {
    h.dispose();
  }
});

it('switches to the full launcher per tab and forgets that on leaving the project', async () => {
  const h = host();
  try {
    h.widget.cwd = 'project';
    await until(() => h.widget.mode === 'home');
    h.widget.showLauncher();
    expect(h.widget.mode).toBe('stock');
    expect(h.widget.title.label).toBe('Launcher');
    expect(h.bodies()).toEqual({ launcher: true, view: false, stockBar: true });
    expect(h.widget.node.textContent).toContain(
      'Showing the full launcher for project.'
    );
    h.widget.showHome();
    expect(h.widget.mode).toBe('home');

    h.widget.showLauncher();
    h.widget.cwd = 'elsewhere';
    await until(() => h.widget.project === null);
    expect(h.bodies()).toEqual({
      launcher: true,
      view: false,
      stockBar: false
    });
    h.widget.cwd = 'project/data';
    await until(() => h.widget.mode === 'home');
  } finally {
    h.dispose();
  }
});

it('re-resolves when the current project changes and ignores stale lookups', async () => {
  const h = host();
  try {
    h.widget.cwd = 'project';
    await until(() => h.widget.mode === 'home');
    jest.spyOn(h.contents, 'get').mockImplementationOnce(
      () => new Promise(() => undefined) // a lookup that never settles
    );
    h.changed.emit();
    h.widget.cwd = 'elsewhere';
    await until(() => h.widget.project === null);
    expect(h.widget.mode).toBe('stock');
  } finally {
    h.dispose();
  }
  expect(h.widget.isDisposed).toBe(true);
});
