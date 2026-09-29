import { bindLabColorScheme } from './astra-kind';
import { ElementHistoryCommandIDs } from './versions/element-history';
import {
  ILayoutRestorer,
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  WidgetTracker
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { ITranslator } from '@jupyterlab/translation';
import { chatLinksPlugin } from './chat-links';
import { commentsPlugin } from './comments';
import { chatPlugin } from './chat-plugin';
import { chatProjectPlugin } from './chat-links/project-plugin';
import { homePlugin } from './home';
import { HomeCommandIDs } from './home/home-commands';
import { mentionsPlugin } from './mentions';
import { searchPlugin } from './search';
import { hasLightconeServer } from './server-features';
import { tabLabelsPlugin } from './tab-labels';
import {
  focusLayoutPlugin,
  lightconeDarkThemePlugin,
  lightconeLightThemePlugin
} from './theme';
import { versionsPlugin } from './versions';
import { currentProjectPlugin, ICurrentProject } from './current-project';
import { projectStatusPlugin } from './project-status';
import { projectNotificationsPlugin } from './project-notifications';
import { astraMimePlugin } from './astra-mime';
import { registerElementCommands } from './element-commands';
import { configureProjectLauncher } from './project-launcher';
import { astraIcon } from './icons';
import { CommandIDs, registerCommands } from './commands';
import { mystraPlugin } from './mystra';
import {
  agentContinuityPlugin,
  sessionPlaceholderPlugin,
  sessionsPlugin
} from './sessions';
import { PALETTE_CATEGORY } from './workbench-ids';
import {
  ASTRA_FILE_TYPE,
  ASTRA_FILE_PATTERN,
  INVENTORY_FACTORY,
  InventoryDocument,
  InventoryDocumentFactory
} from './document-widget';

const PLUGIN_ID = 'jupyterlab_lightcone:plugin';

/** Native JupyterLab integration for the Lightcone Lab research workbench. */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'The open AI-assisted research workbench',
  autoStart: true,
  requires: [IDocumentManager, IThemeManager],
  optional: [
    ICommandPalette,
    ILauncher,
    IFileBrowserFactory,
    ILayoutRestorer,
    ITranslator,
    ILabShell,
    ICurrentProject
  ],
  activate: (
    app: JupyterFrontEnd,
    documents: IDocumentManager,
    themes: IThemeManager,
    palette: ICommandPalette | null,
    launcher: ILauncher | null,
    browser: IFileBrowserFactory | null,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    shell: ILabShell | null,
    current: ICurrentProject | null
  ) => {
    const inventories = new WidgetTracker<InventoryDocument>({
      namespace: 'lightcone-inventory'
    });
    app.docRegistry.addFileType({
      name: ASTRA_FILE_TYPE,
      displayName: 'ASTRA Analysis',
      mimeTypes: ['application/x-astra+yaml'],
      extensions: [],
      pattern: ASTRA_FILE_PATTERN,
      fileFormat: 'text',
      contentType: 'file',
      icon: astraIcon
    });
    const factory = new InventoryDocumentFactory(
      app.serviceManager.contents,
      themes,
      documents
    );
    factory.widgetCreated.connect((_sender, widget) => {
      widget.title.icon = astraIcon;
      widget.context.pathChanged.connect(() => {
        void inventories.save(widget).catch(error => {
          console.warn(
            'Could not save the Lightcone Lab document layout.',
            error
          );
        });
      }, widget);
      void inventories.add(widget).catch(error => {
        console.warn('Could not track the Lightcone Lab document.', error);
      });
    });
    app.docRegistry.addWidgetFactory(factory);
    const themeBinding = bindLabColorScheme(themes);
    app.shell.disposed.connect(() => themeBinding.dispose());
    registerElementCommands(app, documents, themes, restorer, shell);
    for (const command of Object.values(ElementHistoryCommandIDs)) {
      palette?.addItem({ command, category: PALETTE_CATEGORY });
    }
    palette?.addItem({
      command: CommandIDs.pinElement,
      category: PALETTE_CATEGORY
    });
    palette?.addItem({
      command: CommandIDs.unpinElement,
      category: PALETTE_CATEGORY
    });
    registerCommands({
      app,
      documents,
      browser,
      translator: translator ?? undefined,
      labShell: shell
    });
    palette?.addItem({
      command: CommandIDs.createProject,
      category: PALETTE_CATEGORY
    });
    palette?.addItem({
      command: CommandIDs.finishProjectSetup,
      category: PALETTE_CATEGORY
    });
    palette?.addItem({
      command: CommandIDs.openExistingProject,
      category: PALETTE_CATEGORY
    });
    if (launcher && current) {
      configureProjectLauncher(app, launcher, current, {
        project: [CommandIDs.discuss, CommandIDs.openInventory],
        outside: [
          app.commands.hasCommand(HomeCommandIDs.newProject)
            ? HomeCommandIDs.newProject
            : CommandIDs.createProject
        ]
      });
    }
    if (restorer) {
      void restorer.restore(inventories, {
        command: 'docmanager:open',
        args: widget => ({
          path: widget.context.path,
          factory: INVENTORY_FACTORY
        }),
        name: widget => widget.context.path
      });
    }
    palette?.addItem({
      command: CommandIDs.openInventory,
      category: PALETTE_CATEGORY
    });
    palette?.addItem({
      command: CommandIDs.refresh,
      category: PALETTE_CATEGORY
    });
  }
};

/** What runs in the browser alone, on Jupyter's Contents API. */
const browserPlugins: JupyterFrontEndPlugin<unknown>[] = [
  currentProjectPlugin,
  projectStatusPlugin,
  plugin,
  astraMimePlugin,
  projectNotificationsPlugin,
  lightconeLightThemePlugin,
  lightconeDarkThemePlugin,
  focusLayoutPlugin,
  homePlugin,
  versionsPlugin,
  searchPlugin,
  tabLabelsPlugin
];

/**
 * What needs Lightcone's server routes, and with them Jupyter AI and Jupyter
 * Chat: the `jupyterlab-lightcone[full]` install. Left unregistered without
 * it, so no plugin waits for a chat tracker that no extension provides.
 */
const serverPlugins: JupyterFrontEndPlugin<unknown>[] = [
  sessionsPlugin,
  sessionPlaceholderPlugin,
  agentContinuityPlugin,
  chatProjectPlugin,
  chatPlugin,
  chatLinksPlugin,
  mentionsPlugin,
  commentsPlugin,
  // TEMPORARY: the MySTRA Viewer workaround; see AGENTS.md.
  mystraPlugin
];

export default hasLightconeServer()
  ? [...browserPlugins, ...serverPlugins]
  : browserPlugins;
