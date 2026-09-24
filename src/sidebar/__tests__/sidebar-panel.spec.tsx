import { Dialog, InputDialog, type IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../../commands';
import { HomeCommandIDs } from '../../home/home-commands';
import { requestAPI } from '../../request';
import { SearchCommandIDs } from '../../search';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { SidebarCommandIDs, WorkbenchCommandIDs, sidebarPlugin } from '..';
import { RecentProjects } from '../project-switcher';
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
// The sidebar takes the search command's ID from the search plugin module,
// whose sources use Jupyter Chat's icon (an ES module Jest does not transform).
jest.mock('@jupyter/chat', () => ({ chatIcon: { name: 'chat' } }));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => {
  const actual = jest.requireActual('@jupyterlab/apputils');
  return {
    ...actual,
    showErrorMessage: jest.fn().mockResolvedValue(undefined),
    InputDialog: { ...actual.InputDialog, getText: jest.fn() }
  };
});
const request = jest.mocked(requestAPI);
const getText = jest.mocked(InputDialog.getText);

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

function host(
  options: {
    project?: boolean;
    sessions?: boolean;
    projects?: ConstructorParameters<typeof LightconeSidebar>[0]['projects'];
  } = {}
) {
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
    CommandIDs.createProject,
    WorkbenchCommandIDs.createLauncher,
    WorkbenchCommandIDs.goToPath,
    SearchCommandIDs.search
  ]) {
    commands.addCommand(command, {
      execute: args => {
        executed.push([command, args]);
      }
    });
  }
  commands.addKeyBinding({
    command: SearchCommandIDs.search,
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
    themes: new FakeThemeManager(),
    projects: options.projects
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
      // Result titles lead with the inventory's output mark, in the Lightcone
      // ASTRA theme's scope, within the title's text so they share a baseline.
      const results = Array.from(
        h.panel.node.querySelectorAll(`.${BASE}-item`)
      ).filter(row => row.querySelector(`.${BASE}-status`));
      expect(results).toHaveLength(2);
      for (const row of results) {
        const glyph = row.querySelector(
          `.${BASE}-title > .${BASE}-kind.lightcone-brand.astra-ui > .astra-kind-glyph`
        );
        expect(glyph?.getAttribute('data-kind')).toBe('output');
      }
      // Analysis rows count each kind behind its mark; the words stay in
      // the row's label and each count's tooltip.
      const root = h.panel.node.querySelector(`.${BASE}-node`);
      expect(root?.getAttribute('aria-label')).toContain(
        'Decisions 1 · Inputs 1 · Findings 1'
      );
      const tallies = Array.from(
        root?.querySelectorAll<HTMLElement>(`.${BASE}-tally`) ?? []
      );
      expect(tallies.map(tally => tally.dataset.kind)).toEqual([
        'output',
        'decision',
        'input',
        'finding',
        'paper'
      ]);
      expect(
        tallies.map(tally =>
          tally
            .querySelector('.lightcone-brand.astra-ui .astra-kind-glyph')
            ?.getAttribute('data-kind')
        )
      ).toEqual(['output', 'decision', 'input', 'finding', 'paper']);
      expect(tallies[1].title).toBe('Decisions 1');
      expect(h.text()).toContain('Systematics');
      // The project's files and report open from the launcher, not from here.
      expect(h.panel.node.querySelector(`.${BASE}-footer`)).toBeNull();
      expect(h.text()).not.toContain('Files');
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
          h.text().includes('hubble_diagram')
      );
      h.click(`.${BASE}-iconButton`);
      h.click(`.${BASE}-action`, 0);
      h.click(`.${BASE}-action`, 1);
      h.click(`.${BASE}-item`, 1);
      h.click(`.${BASE}-item`, 2);
      h.click(`.${BASE}-more`, 0);
      h.click(`.${BASE}-node`, 1);
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
        [SearchCommandIDs.search, {}],
        [
          CommandIDs.openElement,
          { entrypoint: 'project/astra.yaml', target: 'outputs.hubble_diagram' }
        ],
        [CommandIDs.openInventory, { path: 'project/astra.yaml' }],
        [
          CommandIDs.openInventory,
          { path: 'project/astra.yaml', analysisPath: 'systematics' }
        ]
      ]);
    } finally {
      h.dispose();
    }
  });

  it('switches project from the header by moving the file browser', async () => {
    const siblings = jest.fn(async () => ['other', 'project']);
    const h = host({
      projects: { recent: new RecentProjects(null), siblings }
    });
    try {
      await until(() => h.text().includes('project'));
      const button = h.panel.node.querySelector<HTMLButtonElement>(
        '[aria-label="Switch to another Lightcone project"]'
      );
      expect(button).not.toBeNull();
      button!.click();
      await until(
        () =>
          !!document.querySelector('.jp-jupyterlab-lightcone-ProjectSwitcher')
      );
      expect(siblings).toHaveBeenCalledWith('');
      const menu = document.querySelector<HTMLElement>(
        '.jp-jupyterlab-lightcone-ProjectSwitcher'
      )!;
      expect(menu.textContent).toContain('Projects in this folder');
      expect(menu.textContent).toContain('other');
      expect(menu.textContent).toContain('New Lightcone project');
      // Lumino menus read the legacy key codes: down, then Enter.
      for (const keyCode of [40, 13]) {
        menu.dispatchEvent(
          new KeyboardEvent('keydown', {
            keyCode,
            bubbles: true,
            cancelable: true
          })
        );
      }
      await flush();
      expect(h.executed).toContainEqual([
        WorkbenchCommandIDs.goToPath,
        { path: 'other', dontShowBrowser: true }
      ]);
    } finally {
      h.dispose();
    }
  });

  it('brings the project’s open Home forward when the Home plugin runs', async () => {
    const h = host();
    h.commands.addCommand(HomeCommandIDs.openHome, {
      execute: args => {
        h.executed.push([HomeCommandIDs.openHome, args]);
      }
    });
    try {
      await until(() => h.text().includes('Sidebar project'));
      h.click(`.${BASE}-iconButton`);
      await flush();
      expect(h.executed).toEqual([
        [HomeCommandIDs.openHome, { cwd: 'project' }]
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

  it('fetches nothing while hidden and refreshes once shown again', async () => {
    const h = host();
    try {
      await until(() => h.model.state.sessionsLoaded);
      h.panel.hide();
      expect(h.model.visible).toBe(false);
      const listed = h.sessions!.list.mock.calls.length;
      const requested = request.mock.calls.length;
      // Changes that would refresh a visible sidebar wait until it shows.
      h.sessions!.changed.emit('project/astra.yaml');
      if (!(h.contents.fileChanged instanceof Signal)) {
        throw new Error('The contents manager has no emitting fileChanged.');
      }
      h.contents.fileChanged.emit({
        type: 'new',
        oldValue: null,
        newValue: { path: 'project/chats/new.chat' }
      });
      await flush();
      await flush();
      expect(h.sessions!.list.mock.calls.length).toBe(listed);
      expect(request.mock.calls.length).toBe(requested);
      h.panel.show();
      expect(h.model.visible).toBe(true);
      await until(() => h.sessions!.list.mock.calls.length > listed);
      expect(request.mock.calls.length).toBeGreaterThan(requested);
    } finally {
      h.dispose();
    }
  });

  it('says when materialization status is unavailable', async () => {
    const h = host();
    request.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('api/materialization')) {
        throw new Error('lc is not installed');
      }
      return { papers: {} };
    });
    try {
      await until(() =>
        h.text().includes('Materialization status unavailable')
      );
      const note = h.panel.node.querySelector(`.${BASE}-note`);
      expect(note?.getAttribute('title')).toContain('lc is not installed');
      const dot = h.panel.node.querySelector(
        `.${BASE}-status[data-state='unknown']`
      );
      expect(dot?.getAttribute('title')).toContain('lc is not installed');
    } finally {
      h.dispose();
    }
  });

  it('marks the analysis the current inventory shows', async () => {
    const h = host();
    try {
      await until(() => h.text().includes('Systematics'));
      const scopeChanged = new Signal<object, void>({});
      const inventory = Object.assign(new Widget(), {
        context: { path: 'project/astra.yaml' },
        content: { analysisPath: 'systematics', scopeChanged }
      });
      inventory.addClass('jp-jupyterlab-lightcone-Document');
      h.shell.currentWidget = inventory;
      h.shell.currentChanged.emit({});
      const active = () =>
        Array.from(
          h.panel.node.querySelectorAll(`.${BASE}-node.jp-mod-active`),
          node => node.getAttribute('title')
        );
      await until(() => active().length === 1);
      expect(active()).toEqual(['systematics']);
      inventory.content.analysisPath = '$';
      scopeChanged.emit();
      await until(() => active()[0] === '$');
    } finally {
      h.dispose();
    }
  });

  it('renames a session from its row', async () => {
    const h = host();
    const rename = jest
      .spyOn(h.contents, 'rename')
      .mockImplementation(async (path, newPath) =>
        fileModel('', { path: newPath })
      );
    try {
      await until(() => h.text().includes('Contour styling'));
      getText.mockResolvedValueOnce({
        button: Dialog.okButton(),
        isChecked: null,
        value: 'Contour plots'
      });
      h.click(`.${BASE}-rowAction`, 1);
      await until(() => rename.mock.calls.length === 1);
      expect(getText).toHaveBeenCalledWith(
        // The row's title comes from the first prompt, so only the file moves.
        expect.objectContaining({
          title: 'Rename chat file',
          text: 'contours',
          suffix: '.chat'
        })
      );
      expect(rename).toHaveBeenCalledWith(
        'project/chats/contours.chat',
        'project/chats/contour-plots.chat'
      );
      // Cancelling renames nothing.
      getText.mockResolvedValueOnce({
        button: Dialog.cancelButton(),
        isChecked: null,
        value: null
      });
      h.click(`.${BASE}-rowAction`, 0);
      await flush();
      await flush();
      expect(rename).toHaveBeenCalledTimes(1);
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
