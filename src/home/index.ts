import {
  ILabShell,
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  MainAreaWidget,
  WidgetTracker
} from '@jupyterlab/apputils';
import {
  IDefaultFileBrowser,
  type FileBrowserModel
} from '@jupyterlab/filebrowser';
import { ILauncher, LauncherModel } from '@jupyterlab/launcher';
import { IStateDB } from '@jupyterlab/statedb';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { addIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import { UUID, type ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { DockPanel, TabBar, Widget } from '@lumino/widgets';
import { CommandIDs } from '../commands';
import { ICurrentProject } from '../current-project';
import { createProjectIcon } from '../icons';
import { findProjectRoot } from '../project-root';
import { ISessionService } from '../sessions/session-service';
import { HomeCommandIDs } from './home-commands';
import { HomeWidget } from './home-widget';
import { lightconeIcon } from './icons';
import { PersonaDirectory } from './personas';
import { buildToolsMenu } from './tools-menu';

export { HomeCommandIDs } from './home-commands';
export { HomeWidget } from './home-widget';
export { lightconeIcon } from './icons';

type HomeTab = MainAreaWidget<HomeWidget>;

/** The incrementing id used for launcher widgets. */
let launcherCount = 0;

/**
 * Provide the launcher service and open Home inside Lightcone projects.
 *
 * This replaces `@jupyterlab/launcher-extension:plugin`: it reuses the stock
 * launcher model, so items other extensions add keep working, and registers
 * `launcher:create` with the stock semantics for every entry point (the tab
 * bar's + button, the File menu, the shortcut, the file browser button and
 * an emptied main area). Outside a project the tab shows the stock launcher.
 */
export const homePlugin: JupyterFrontEndPlugin<ILauncher> = {
  // The id carries the npm package name because `schema/home.json` (menu,
  // shortcut and toolbar entries) is published as `jupyterlab-lightcone:home`,
  // and JupyterLab only loads a settings schema whose id names a registered
  // plugin.
  id: 'jupyterlab-lightcone:home',
  description:
    'The launcher service, showing a Lightcone project’s Home inside projects.',
  autoStart: true,
  provides: ILauncher,
  requires: [ICurrentProject, IThemeManager],
  optional: [
    ILabShell,
    IDefaultFileBrowser,
    ICommandPalette,
    ITranslator,
    IStateDB,
    ILayoutRestorer
  ],
  activate
};

function activate(
  app: JupyterFrontEnd,
  current: ICurrentProject,
  themes: IThemeManager,
  labShell: ILabShell | null,
  defaultBrowser: IDefaultFileBrowser | null,
  palette: ICommandPalette | null,
  translator: ITranslator | null,
  state: IStateDB | null,
  restorer: ILayoutRestorer | null = null
): ILauncher {
  const { commands, shell } = app;
  const contents = app.serviceManager.contents;
  const labTrans = (translator ?? nullTranslator).load('jupyterlab');
  const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
  if (commands.hasCommand(HomeCommandIDs.create)) {
    throw new Error(
      'launcher:create is already registered: disable @jupyterlab/launcher-extension:plugin so Lightcone Home can provide the launcher.'
    );
  }
  const model = new LauncherModel();
  const tracker = new WidgetTracker<HomeTab>({ namespace: 'lightcone-home' });
  /** The name each Home tab has in the saved layout. */
  const restoreKeys = new WeakMap<HomeTab, string>();
  // The sessions service is looked up after activation rather than declared:
  // the launcher provider must not depend on the chat tracker behind it, since
  // core plugins such as the notebook tracker consume `ILauncher` themselves and
  // the plugin registry would refuse the cycle.
  let sessions: ISessionService | null = null;
  let personas: PersonaDirectory | null = null;
  void app
    .resolveOptionalService(ISessionService)
    .then(service => {
      if (!service || app.shell.isDisposed) {
        return;
      }
      sessions = service;
      personas = new PersonaDirectory(app.serviceManager.events, state);
      tracker.forEach(tab => tab.content.setSessions(sessions, personas));
    })
    .catch(error => {
      console.warn('Lightcone Home runs without the sessions service.', error);
    });
  app.shell.disposed.connect(() => {
    personas?.dispose();
    tracker.dispose();
  });

  const homeTab = (args: ReadonlyPartialJSONObject): HomeTab | undefined => {
    if (typeof args.widgetId === 'string') {
      const id = args.widgetId;
      return tracker.find(tab => tab.id === id);
    }
    const currentWidget = shell.currentWidget;
    return tracker.find(tab => tab === currentWidget);
  };

  const openTools = (tab: HomeTab, anchor: HTMLElement) => {
    const menu = buildToolsMenu({
      model,
      commands,
      cwd: tab.content.cwd,
      widgetId: tab.id,
      translator: translator ?? undefined
    });
    menu.aboutToClose.connect(() => {
      window.setTimeout(() => menu.dispose(), 0);
    });
    // The button sits at the header's right end: the menu hangs from its
    // right edge instead of running past the window's.
    const rect = anchor.getBoundingClientRect();
    menu.open(rect.right, rect.bottom + 4, { horizontalAlignment: 'right' });
  };

  /**
   * Open a Home tab. `restoreKey` names it in the saved layout, so a reload
   * puts it back where it was, as it does with documents; the stock launcher
   * tab was never restored, but Home is a project's front page.
   */
  const createTab = (
    args: ReadonlyPartialJSONObject,
    restoreKey: string
  ): HomeTab => {
    const cwd =
      typeof args.cwd === 'string'
        ? args.cwd
        : (defaultBrowser?.model.path ?? '');
    const id = `launcher-${launcherCount++}`;
    const callback = (item: Widget) => {
      // A launched document replaces the stock launcher body, as it always has.
      if (find(shell.widgets('main'), widget => widget === item)) {
        shell.add(item, 'main', { ref: id });
        main.dispose();
      }
    };
    const home = new HomeWidget({
      model,
      cwd,
      commands,
      contents,
      themes,
      current,
      callback,
      onOpenTools: anchor => openTools(main, anchor),
      translator: translator ?? undefined,
      sessions,
      personas,
      state
    });
    const main = new MainAreaWidget({ content: home });
    main.id = id;
    // If there are any other widgets open, remove the launcher close icon.
    main.title.closable = !!Array.from(shell.widgets('main')).length;
    shell.add(main, 'main', {
      activate: typeof args.activate === 'boolean' ? args.activate : undefined,
      ref: typeof args.ref === 'string' ? args.ref : undefined
    });
    restoreKeys.set(main, restoreKey);
    void tracker.add(main);
    if (labShell) {
      const onLayoutModified = () => {
        // If there is only a launcher open, remove the close icon.
        main.title.closable = Array.from(labShell.widgets('main')).length > 1;
      };
      labShell.layoutModified.connect(onLayoutModified);
      main.disposed.connect(() => {
        labShell.layoutModified.disconnect(onLayoutModified);
      });
    }
    if (defaultBrowser) {
      const onPathChanged = (browserModel: FileBrowserModel) => {
        home.cwd = browserModel.path;
        // The saved layout reopens the tab on the folder it last showed.
        void tracker.save(main);
      };
      defaultBrowser.model.pathChanged.connect(onPathChanged);
      home.disposed.connect(() => {
        defaultBrowser.model.pathChanged.disconnect(onPathChanged);
      });
    }
    return main;
  };

  commands.addCommand(HomeCommandIDs.create, {
    label: labTrans.__('New Launcher'),
    icon: args => (args.toolbar ? addIcon : undefined),
    describedBy: {
      args: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description: labTrans.__('The current working directory')
          },
          toolbar: {
            type: 'boolean',
            description: labTrans.__(
              'Whether the command is executed from a toolbar'
            )
          },
          activate: {
            type: 'boolean',
            description: labTrans.__('Whether to activate the widget')
          },
          ref: {
            type: 'string',
            description: labTrans.__('The reference widget id')
          }
        }
      }
    },
    execute: (args: ReadonlyPartialJSONObject) => createTab(args, UUID.uuid4())
  });

  commands.addCommand(HomeCommandIDs.restore, {
    label: trans.__('Restore Home'),
    describedBy: {
      args: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          key: { type: 'string' }
        }
      }
    },
    execute: args =>
      createTab(
        { cwd: typeof args.cwd === 'string' ? args.cwd : '', activate: false },
        typeof args.key === 'string' && args.key ? args.key : UUID.uuid4()
      )
  });
  if (restorer) {
    void restorer.restore(tracker, {
      command: HomeCommandIDs.restore,
      args: tab => ({ cwd: tab.content.cwd, key: restoreKeys.get(tab) ?? '' }),
      name: tab => restoreKeys.get(tab) ?? tab.id
    });
  }

  commands.addCommand(HomeCommandIDs.openHome, {
    label: trans.__('Open Home'),
    caption: trans.__('Show the Lightcone project’s Home'),
    icon: lightconeIcon,
    describedBy: {
      args: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description: trans.__('A folder inside the project')
          }
        }
      }
    },
    execute: async args => {
      const cwd =
        typeof args.cwd === 'string'
          ? args.cwd
          : (defaultBrowser?.model.path ?? '');
      // Every Home tab follows the file browser, so a tab already showing
      // this project is usually open: bring it forward rather than stacking
      // another one. Otherwise open Home as every other entry point does.
      const project = await findProjectRoot(contents, cwd);
      const open = project
        ? tracker.find(
            tab =>
              tab.content.mode === 'home' &&
              tab.content.project?.entrypoint === project.entrypoint
          )
        : undefined;
      if (open) {
        shell.activateById(open.id);
        return open;
      }
      return commands.execute(HomeCommandIDs.create, { cwd, activate: true });
    }
  });

  commands.addCommand(HomeCommandIDs.newProject, {
    label: trans.__('New Lightcone project'),
    caption: trans.__('Set up a Lightcone project in this folder'),
    icon: createProjectIcon,
    describedBy: {
      args: {
        type: 'object',
        properties: { cwd: { type: 'string' }, path: { type: 'string' } }
      }
    },
    execute: args => commands.execute(CommandIDs.createProject, args)
  });

  commands.addCommand(HomeCommandIDs.showLauncher, {
    label: trans.__('Show the full launcher'),
    caption: trans.__('Show the stock launcher in this Home tab'),
    describedBy: {
      args: { type: 'object', properties: { widgetId: { type: 'string' } } }
    },
    isEnabled: args => homeTab(args)?.content.mode === 'home',
    execute: args => {
      const tab = homeTab(args);
      if (tab) {
        tab.content.showLauncher();
        shell.activateById(tab.id);
      }
    }
  });

  commands.addCommand(HomeCommandIDs.showHome, {
    label: trans.__('Back to Home'),
    caption: trans.__('Show the project’s Home in this launcher tab'),
    describedBy: {
      args: { type: 'object', properties: { widgetId: { type: 'string' } } }
    },
    isEnabled: args => {
      const tab = homeTab(args);
      return !!tab && !!tab.content.project && tab.content.mode === 'stock';
    },
    execute: args => {
      const tab = homeTab(args);
      if (tab) {
        tab.content.showHome();
        shell.activateById(tab.id);
      }
    }
  });

  commands.addCommand(HomeCommandIDs.toolsCategory, {
    label: args => (typeof args.category === 'string' ? args.category : ''),
    describedBy: {
      args: { type: 'object', properties: { category: { type: 'string' } } }
    },
    isEnabled: () => false,
    execute: () => undefined
  });

  shell.currentChanged?.connect(() => {
    commands.notifyCommandChanged(HomeCommandIDs.showLauncher);
    commands.notifyCommandChanged(HomeCommandIDs.showHome);
  });

  if (labShell) {
    void Promise.all([app.restored, defaultBrowser?.model.restored]).then(
      () => {
        // When layout is modified, create a launcher if there are no open items.
        labShell.layoutModified.connect(() => {
          if (labShell.isEmpty('main')) {
            void commands.execute(HomeCommandIDs.create);
          }
        });
      }
    );
    labShell.addButtonEnabled = true;
    labShell.addRequested.connect((sender: DockPanel, arg: TabBar<Widget>) => {
      // Get the ref for the current tab of the tabbar which the add button was clicked
      const ref =
        arg.currentTitle?.owner.id ||
        arg.titles[arg.titles.length - 1].owner.id;
      return commands.execute(HomeCommandIDs.create, { ref });
    });
  }

  if (palette) {
    palette.addItem({
      command: HomeCommandIDs.create,
      category: labTrans.__('Launcher')
    });
    palette.addItem({
      command: HomeCommandIDs.openHome,
      category: 'Lightcone Lab'
    });
    palette.addItem({
      command: HomeCommandIDs.newProject,
      category: 'Lightcone Lab'
    });
    palette.addItem({
      command: HomeCommandIDs.showLauncher,
      category: 'Lightcone Lab'
    });
    palette.addItem({
      command: HomeCommandIDs.showHome,
      category: 'Lightcone Lab'
    });
  }

  return model;
}
