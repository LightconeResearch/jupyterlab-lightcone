import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../../commands';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { SidebarCommandIDs, WorkbenchCommandIDs, sidebarPlugin } from '..';
import { SidebarModel } from '../sidebar-model';
import { LightconeSidebar } from '../sidebar-panel';
import {
  FakeCommentService,
  FakeCurrentProject,
  FakeSessionService,
  PROJECT_SPEC,
  flush,
  session,
  until
} from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
const request = jest.mocked(requestAPI);

class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

const BASE = 'jp-jupyterlab-lightcone-Sidebar';

function host(options: { project?: boolean; sessions?: boolean } = {}) {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC),
    'project/myst.yml': fileModel('project: {}')
  });
  request.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return {
        outputs: {
          'default/hubble_diagram': { state: 'current', detail: '' },
          'default/cosmology_fit': { state: 'behind', detail: 'recipe' }
        }
      };
    }
    return { papers: {} };
  });
  const commands = new CommandRegistry();
  const executed: [string, unknown][] = [];
  for (const command of [
    CommandIDs.openElement,
    CommandIDs.openInventory,
    CommandIDs.openMySTRA,
    CommandIDs.createProject,
    WorkbenchCommandIDs.createLauncher,
    WorkbenchCommandIDs.goToPath,
    WorkbenchCommandIDs.search
  ]) {
    commands.addCommand(command, {
      execute: args => {
        executed.push([command, args]);
      }
    });
  }
  commands.addKeyBinding({
    command: WorkbenchCommandIDs.search,
    keys: ['Accel K'],
    selector: 'body'
  });
  const current = new FakeCurrentProject(
    options.project === false
      ? null
      : { path: 'project', entrypoint: 'project/astra.yaml' }
  );
  const sessions = options.sessions === false ? null : new FakeSessionService();
  sessions?.listings.set('project/astra.yaml', [
    session(),
    session({
      path: 'project/chats/contours.chat',
      title: 'Contour styling',
      activity: 'working'
    })
  ]);
  const comments = new FakeCommentService();
  comments.counts.set('project/astra.yaml', 1);
  const shell = {
    currentWidget: null as Widget | null,
    currentChanged: new Signal<object, unknown>({})
  };
  const model = new SidebarModel({
    contents,
    shell,
    current,
    sessions,
    comments
  });
  const panel = new LightconeSidebar({
    commands,
    model,
    themes: new FakeThemeManager()
  });
  Widget.attach(panel, document.body);
  const text = () => panel.node.textContent ?? '';
  const click = (selector: string, index = 0) => {
    const elements = panel.node.querySelectorAll<HTMLElement>(selector);
    const element = elements[index];
    if (!element) {
      throw new Error(`No element matches ${selector} at ${index}.`);
    }
    element.click();
  };
  return {
    contents,
    commands,
    executed,
    current,
    sessions,
    comments,
    shell,
    model,
    panel,
    text,
    click,
    dispose: () => {
      Widget.detach(panel);
      panel.dispose();
      model.dispose();
      contents.dispose();
    }
  };
}

beforeEach(() => {
  request.mockReset();
});

describe('LightconeSidebar', () => {
  it('shows the project, its verbs, sessions, results, analysis and links', async () => {
    const h = host();
    try {
      await until(
        () =>
          h.text().includes('Contour styling') &&
          h.text().includes('hubble_diagram') &&
          h.text().includes('Sidebar project')
      );
      expect(h.model.visible).toBe(true);
      expect(h.text()).toContain('project');
      expect(h.text()).toContain('New session');
      expect(h.text()).toContain('Search');
      expect(h.text()).toContain(CommandRegistry.formatKeystroke('Accel K'));
      expect(h.text()).toContain('1 pending comment');
      expect(h.panel.content.widgets.map(widget => widget.title.label)).toEqual(
        ['Sessions', 'Results', 'Analysis']
      );
      await until(() => h.text().includes('1 ✓ · 1 behind'));
      expect(h.text()).toContain('Decisions 1 · Inputs 1 · Findings 1');
      expect(h.text()).toContain('Systematics');
      await until(() => h.text().includes('Files'));
      expect(h.text()).toContain('Report');
      // Runs is not registered, so its link is absent.
      expect(h.text()).not.toContain('Runs');
      const working = h.panel.node.querySelector(
        `.${BASE}-marker[data-state='working']`
      );
      expect(working).not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('routes every action to the right command or service', async () => {
    const h = host();
    try {
      await until(
        () =>
          h.text().includes('Contour styling') &&
          h.text().includes('hubble_diagram') &&
          h.text().includes('Report')
      );
      await until(
        () =>
          !h.panel.node.querySelector<HTMLButtonElement>(
            `.${BASE}-link[disabled]`
          )
      );
      h.click(`.${BASE}-iconButton`);
      h.click(`.${BASE}-action`, 0);
      h.click(`.${BASE}-action`, 1);
      h.click(`.${BASE}-item`, 1);
      h.click(`.${BASE}-item`, 2);
      h.click(`.${BASE}-more`, 0);
      h.click(`.${BASE}-node`, 1);
      h.click(`.${BASE}-link`, 0);
      h.click(`.${BASE}-link`, 1);
      await flush();
      expect(h.sessions!.createAndOpen).toHaveBeenCalledWith(
        'project/astra.yaml'
      );
      expect(h.sessions!.openSession).toHaveBeenCalledWith(
        'project/chats/contours.chat'
      );
      expect(h.executed).toEqual([
        [
          WorkbenchCommandIDs.createLauncher,
          { cwd: 'project', activate: true }
        ],
        [WorkbenchCommandIDs.search, {}],
        [
          CommandIDs.openElement,
          { entrypoint: 'project/astra.yaml', target: 'outputs.hubble_diagram' }
        ],
        [CommandIDs.openInventory, { path: 'project/astra.yaml' }],
        [
          CommandIDs.openInventory,
          { path: 'project/astra.yaml', analysisPath: 'systematics' }
        ],
        [WorkbenchCommandIDs.goToPath, { path: 'project' }],
        [CommandIDs.openMySTRA, { cwd: 'project' }]
      ]);
    } finally {
      h.dispose();
    }
  });

  it('highlights the current session and record', async () => {
    const h = host();
    try {
      await until(
        () =>
          h.text().includes('Contour styling') &&
          h.text().includes('hubble_diagram')
      );
      h.shell.currentWidget = Object.assign(new Widget(), {
        context: { path: 'project/chats/contours.chat' }
      });
      h.shell.currentChanged.emit({});
      await until(
        () =>
          h.panel.node
            .querySelector(`.${BASE}-item.jp-mod-active`)
            ?.textContent?.includes('Contour styling') ?? false
      );
      const record = Object.assign(new Widget(), {
        content: {
          reference: {
            entrypoint: 'project/astra.yaml',
            target: 'outputs.cosmology_fit'
          }
        }
      });
      record.title.dataset = { 'lightcone-element': record.id };
      h.shell.currentWidget = record;
      h.shell.currentChanged.emit({});
      await until(() => {
        const active = h.panel.node.querySelectorAll(
          `.${BASE}-item.jp-mod-active`
        );
        return (
          active.length === 1 &&
          (active[0].textContent?.includes('cosmology_fit') ?? false)
        );
      });
    } finally {
      h.dispose();
    }
  });

  it('offers a new project outside projects and never removes the header', async () => {
    const h = host({ project: false });
    try {
      await until(() => h.text().includes('No Lightcone project'));
      expect(h.panel.content.widgets).toHaveLength(0);
      expect(h.text()).toContain('New project');
      expect(h.text()).not.toContain('Files');
      h.click(`.${BASE}-button`);
      await flush();
      expect(h.executed).toEqual([[CommandIDs.createProject, {}]]);
      h.current.set({ path: 'project', entrypoint: 'project/astra.yaml' });
      await until(() => h.text().includes('Sidebar project'));
      expect(h.panel.content.widgets).toHaveLength(3);
      h.current.set(undefined);
      await until(() => h.text().includes('Looking for a project'));
      expect(h.panel.content.widgets).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('hides the sessions section and verb without a session service', async () => {
    const h = host({ sessions: false });
    try {
      await until(() => h.text().includes('hubble_diagram'));
      expect(h.panel.content.widgets.map(widget => widget.title.label)).toEqual(
        ['Results', 'Analysis']
      );
      expect(h.text()).not.toContain('New session');
    } finally {
      h.dispose();
    }
  });

  it('pauses polling while hidden', async () => {
    const h = host();
    try {
      await until(() => h.model.state.sessionsLoaded);
      h.panel.hide();
      expect(h.model.visible).toBe(false);
      h.panel.show();
      expect(h.model.visible).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe('sidebarPlugin', () => {
  it('adds the panel to the left area and registers the show command', async () => {
    const { contents } = createContents({});
    const added: [Widget, string, unknown][] = [];
    const activated: string[] = [];
    const commands = new CommandRegistry();
    const shell = {
      currentWidget: null,
      currentChanged: new Signal<object, unknown>({}),
      disposed: new Signal<object, void>({}),
      add: (widget: Widget, area: string, options: unknown) => {
        added.push([widget, area, options]);
      },
      activateById: (id: string) => {
        activated.push(id);
      }
    };
    const restored: string[] = [];
    const restorer = {
      add: (_widget: Widget, name: string) => restored.push(name)
    };
    const palette = { addItem: jest.fn() };
    const app = {
      commands,
      shell,
      serviceManager: { contents }
    } as unknown as Parameters<typeof sidebarPlugin.activate>[0];
    sidebarPlugin.activate(
      app,
      new FakeCurrentProject(null),
      new FakeThemeManager(),
      null,
      restorer,
      null,
      null,
      palette
    );
    try {
      expect(added).toHaveLength(1);
      const [panel, area, options] = added[0];
      expect(area).toBe('left');
      expect(options).toEqual({ rank: 250, type: 'Lightcone' });
      expect(panel.id).toBe('jp-lightcone-sidebar');
      expect(restored).toEqual(['lightcone-sidebar']);
      expect(palette.addItem).toHaveBeenCalledWith({
        command: SidebarCommandIDs.showSidebar,
        category: 'Lightcone Lab'
      });
      await commands.execute(SidebarCommandIDs.showSidebar);
      expect(activated).toEqual(['jp-lightcone-sidebar']);
      expect(sidebarPlugin.requires?.length).toBe(2);
    } finally {
      shell.disposed.emit();
      contents.dispose();
    }
  });
});
