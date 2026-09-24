import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import { StateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import type { TabBar, Widget } from '@lumino/widgets';
import { CommandIDs } from '../../commands';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { HomeCommandIDs, HomeWidget, homePlugin } from '..';
import { PersonaDirectory, PERSONAS_STATE_KEY } from '../personas';
import {
  FakeCurrentProject,
  FakeEvents,
  FakeSessionService,
  FakeThemeManager,
  flush,
  until
} from './home-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

type HomeTab = MainAreaWidget<HomeWidget>;

function isHomeTab(value: unknown): value is HomeTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    value.content instanceof HomeWidget
  );
}

/** The default file browser's model: the plugin reads the folder from the sender. */
class FakeBrowserModel {
  path = 'project';
  readonly restored = Promise.resolve();
  readonly pathChanged = new Signal<this, unknown>(this);
}

/** The layout restorer: records what the plugin asks it to restore. */
class FakeRestorer {
  tracker: unknown;
  options: {
    command: string;
    args: (tab: HomeTab) => Record<string, unknown>;
    name: (tab: HomeTab) => string;
  } | null = null;
  restore(tracker: unknown, options: FakeRestorer['options']): Promise<void> {
    this.tracker = tracker;
    this.options = options;
    return Promise.resolve();
  }
}

/** A JupyterLab-like application around the Home plugin. */
function pluginHost(
  options: {
    sessions?: FakeSessionService | null;
    restorer?: FakeRestorer | null;
  } = {}
) {
  const entries: Record<string, Contents.IModel> = {
    'project/astra.yaml': fileModel(analysis('Union 2.1 cosmology')),
    'elsewhere/notes.txt': fileModel('notes')
  };
  const { contents, get } = createContents(entries);
  const commands = new CommandRegistry();
  const main: Widget[] = [];
  const added: { widget: Widget; options: unknown }[] = [];
  const shell = {
    currentWidget: null as Widget | null,
    currentChanged: new Signal<object, unknown>({}),
    disposed: new Signal<object, void>({}),
    isDisposed: false,
    widgets: (area?: string) =>
      (area === 'main' ? [...main] : [])[Symbol.iterator](),
    add: (widget: Widget, _area: string, addOptions?: unknown) => {
      main.push(widget);
      added.push({ widget, options: addOptions });
    },
    activateById: jest.fn()
  };
  const labShell = {
    layoutModified: new Signal<object, void>({}),
    addRequested: new Signal<object, TabBar<Widget>>({}),
    addButtonEnabled: false,
    empty: false,
    isEmpty(): boolean {
      return this.empty;
    },
    widgets: shell.widgets
  };
  const browserModel = new FakeBrowserModel();
  const events = new FakeEvents();
  const state = new StateDB();
  const sessions =
    options.sessions === undefined
      ? new FakeSessionService()
      : options.sessions;
  const app = {
    commands,
    shell,
    restored: Promise.resolve(),
    serviceManager: { contents, events },
    resolveOptionalService: jest.fn(async () => sessions)
  } as unknown as Parameters<typeof homePlugin.activate>[0];
  const palette = { addItem: jest.fn() };
  const activate = () =>
    homePlugin.activate(
      app,
      new FakeCurrentProject(),
      new FakeThemeManager(),
      labShell,
      { model: browserModel },
      palette,
      null,
      state,
      (options.restorer ?? null) as never
    );
  const create = async (
    args: Record<string, string | boolean> = {}
  ): Promise<HomeTab> => {
    const tab: unknown = await commands.execute(HomeCommandIDs.create, args);
    if (!isHomeTab(tab)) {
      throw new Error('launcher:create did not return a Home tab.');
    }
    return tab;
  };
  return {
    commands,
    get,
    shell,
    labShell,
    browserModel,
    events,
    state,
    sessions,
    palette,
    main,
    added,
    activate,
    create,
    dispose: () => {
      shell.disposed.emit();
      main.forEach(widget => widget.dispose());
      contents.dispose();
    }
  };
}

describe('homePlugin', () => {
  it('refuses to start beside the stock launcher plugin', () => {
    const h = pluginHost();
    h.commands.addCommand(HomeCommandIDs.create, { execute: () => undefined });
    try {
      expect(() => h.activate()).toThrow(/already registered/);
    } finally {
      h.dispose();
    }
  });

  it('opens launcher tabs from every entry point, in the file browser folder', async () => {
    const h = pluginHost();
    try {
      h.activate();
      expect(h.labShell.addButtonEnabled).toBe(true);
      expect(h.palette.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ command: HomeCommandIDs.create })
      );

      // The first tab of an empty main area cannot be closed.
      const first = await h.create();
      expect(first.content.cwd).toBe('project');
      expect(first.title.closable).toBe(false);
      const second = await h.create({ cwd: 'elsewhere', activate: false });
      expect(second.content.cwd).toBe('elsewhere');
      expect(second.title.closable).toBe(true);
      expect(h.added[1].options).toEqual({ activate: false, ref: undefined });

      // The tab bar's + button opens beside the tab bar's current tab.
      const bar = {
        currentTitle: { owner: first },
        titles: [first.title]
      } as unknown as TabBar<Widget>;
      h.labShell.addRequested.emit(bar);
      await flush();
      expect(h.main).toHaveLength(3);
      expect(h.added[2].options).toEqual({
        activate: undefined,
        ref: first.id
      });

      // Tabs follow the file browser.
      h.browserModel.path = 'elsewhere';
      h.browserModel.pathChanged.emit(undefined);
      expect(first.content.cwd).toBe('elsewhere');

      // An emptied main area gets a launcher again once the app is restored.
      await flush();
      h.labShell.empty = true;
      h.labShell.layoutModified.emit();
      await flush();
      expect(h.main).toHaveLength(4);
    } finally {
      h.dispose();
    }
  });

  it('restores Home tabs from the saved layout under a stable name', async () => {
    const restorer = new FakeRestorer();
    const h = pluginHost({ restorer });
    try {
      h.activate();
      const options = restorer.options;
      expect(options?.command).toBe(HomeCommandIDs.restore);
      const first = await h.create();
      const second = await h.create({ cwd: 'elsewhere' });
      const key = options!.name(first);
      expect(key).not.toBe(options!.name(second));
      expect(options!.args(first)).toEqual({ cwd: 'project', key });

      // A reload recreates the tab under the same name, without focusing it.
      const restored: unknown = await h.commands.execute(
        HomeCommandIDs.restore,
        { cwd: 'project', key }
      );
      if (!isHomeTab(restored)) {
        throw new Error('The restore command did not return a Home tab.');
      }
      expect(options!.name(restored)).toBe(key);
      expect(restored.content.cwd).toBe('project');
      expect(h.added[2].options).toEqual({ activate: false, ref: undefined });
    } finally {
      h.dispose();
    }
  });

  it('switches a tab between Home and the full launcher', async () => {
    const h = pluginHost();
    try {
      h.activate();
      const tab = await h.create();
      const args = { widgetId: tab.id };
      expect(h.commands.isEnabled(HomeCommandIDs.showLauncher, args)).toBe(
        false
      );
      await until(() => tab.content.mode === 'home');
      expect(h.commands.isEnabled(HomeCommandIDs.showLauncher, args)).toBe(
        true
      );
      expect(h.commands.isEnabled(HomeCommandIDs.showHome, args)).toBe(false);

      await h.commands.execute(HomeCommandIDs.showLauncher, args);
      expect(tab.content.mode).toBe('stock');
      expect(h.shell.activateById).toHaveBeenCalledWith(tab.id);
      expect(h.commands.isEnabled(HomeCommandIDs.showHome, args)).toBe(true);
      await h.commands.execute(HomeCommandIDs.showHome, args);
      expect(tab.content.mode).toBe('home');
    } finally {
      h.dispose();
    }
  });

  it('brings a project’s open Home forward instead of stacking another', async () => {
    const h = pluginHost();
    try {
      h.activate();
      const tab = await h.create();
      await until(() => tab.content.mode === 'home');
      h.shell.activateById.mockClear();

      const shown: unknown = await h.commands.execute(HomeCommandIDs.openHome, {
        cwd: 'project'
      });
      expect(shown).toBe(tab);
      expect(h.shell.activateById).toHaveBeenCalledWith(tab.id);
      expect(h.main).toHaveLength(1);

      // A tab switched to the full launcher is not Home: a new tab opens.
      tab.content.showLauncher();
      const opened: unknown = await h.commands.execute(
        HomeCommandIDs.openHome,
        { cwd: 'project' }
      );
      expect(opened).not.toBe(tab);
      expect(h.main).toHaveLength(2);
      // Outside any project it opens a launcher in that folder.
      const elsewhere: unknown = await h.commands.execute(
        HomeCommandIDs.openHome,
        { cwd: 'elsewhere' }
      );
      expect(isHomeTab(elsewhere) && elsewhere.content.cwd).toBe('elsewhere');
      expect(h.main).toHaveLength(3);
    } finally {
      h.dispose();
    }
  });

  it('brings forward the tab that followed the browser into a project, even before it has looked it up', async () => {
    const h = pluginHost();
    try {
      h.browserModel.path = 'elsewhere';
      h.activate();
      const tab = await h.create();
      await until(() => tab.content.project === null);
      // The tab's own lookup answers late, so Open Home's would settle first.
      const read = h.get.getMockImplementation()!;
      let slow = true;
      h.get.mockImplementation(async (path, options) => {
        if (slow) await new Promise(resolve => setTimeout(resolve, 30));
        return read(path, options);
      });
      h.browserModel.path = 'project';
      h.browserModel.pathChanged.emit(undefined);
      slow = false;
      const shown: unknown = await h.commands.execute(HomeCommandIDs.openHome, {
        cwd: 'project'
      });
      h.get.mockImplementation(read);
      expect(shown).toBe(tab);
      expect(tab.content.mode).toBe('home');
      expect(h.main).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('offers New Lightcone project through the project creation command', async () => {
    const h = pluginHost();
    const createProject = jest.fn();
    h.commands.addCommand(CommandIDs.createProject, {
      execute: args => createProject(args)
    });
    try {
      h.activate();
      expect(h.commands.label(HomeCommandIDs.newProject)).toBe(
        'New Lightcone project'
      );
      await h.commands.execute(HomeCommandIDs.newProject, { cwd: 'work' });
      expect(createProject).toHaveBeenCalledWith({ cwd: 'work' });
    } finally {
      h.dispose();
    }
  });

  it('hands the sessions service and the remembered agents to open tabs', async () => {
    const h = pluginHost();
    const setSessions = jest.spyOn(HomeWidget.prototype, 'setSessions');
    const codex = { id: 'jupyter-ai-personas::codex::Codex', name: 'Codex' };
    await h.state.save(PERSONAS_STATE_KEY, [codex]);
    try {
      h.activate();
      const tab = await h.create();
      await until(() => setSessions.mock.calls.length > 0);
      const [sessions, personas] = setSessions.mock.calls[0];
      expect(sessions).toBe(h.sessions);
      expect(personas).toBeInstanceOf(PersonaDirectory);
      await until(() => (personas?.personas.length ?? 0) > 0);
      expect(personas?.personas).toEqual([codex]);
      expect(setSessions.mock.contexts[0]).toBe(tab.content);
    } finally {
      setSessions.mockRestore();
      h.dispose();
    }
  });
});
