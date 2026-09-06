import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  MainAreaWidget,
  WidgetTracker
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator } from '@jupyterlab/translation';
import { listIcon } from '@jupyterlab/ui-components';
import { CommandIDs, registerCommands } from './commands';
import {
  ASTRA_FILE_TYPE,
  ASTRA_FILE_PATTERN,
  INVENTORY_FACTORY,
  InventoryDocument,
  InventoryDocumentFactory
} from './document-widget';
import { PaperPanel } from './paper-panel';
import { themePlugin } from './theme';

const PLUGIN_ID = 'jupyterlab_lightcone:plugin';
const SETTINGS_ID = '@lightcone-research/jupyterlab-lightcone:plugin';
const CATEGORY = 'lightcone lab';

/** Native document, launcher, and publication integration for lightcone lab. */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'The open AI workbench for scientific research.',
  autoStart: true,
  requires: [IDocumentManager, IThemeManager],
  optional: [
    ICommandPalette,
    ILauncher,
    IFileBrowserFactory,
    ILayoutRestorer,
    ISettingRegistry,
    ITranslator
  ],
  activate: async (
    app: JupyterFrontEnd,
    documents: IDocumentManager,
    themes: IThemeManager,
    palette: ICommandPalette | null,
    launcher: ILauncher | null,
    browser: IFileBrowserFactory | null,
    restorer: ILayoutRestorer | null,
    settingsRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ) => {
    const inventories = new WidgetTracker<InventoryDocument>({
      namespace: 'lightcone-inventory'
    });
    const papers = new WidgetTracker<MainAreaWidget<PaperPanel>>({
      namespace: 'lightcone-paper'
    });
    let settings: ISettingRegistry.ISettings | undefined;
    if (settingsRegistry) {
      try {
        settings = await settingsRegistry.load(SETTINGS_ID);
      } catch (error) {
        console.warn('Could not load lightcone lab settings.', error);
      }
    }
    app.docRegistry.addFileType({
      name: ASTRA_FILE_TYPE,
      displayName: 'ASTRA Analysis',
      mimeTypes: ['application/x-astra+yaml'],
      extensions: [],
      pattern: ASTRA_FILE_PATTERN,
      fileFormat: 'text',
      contentType: 'file',
      icon: listIcon
    });
    const factory = new InventoryDocumentFactory(
      app.serviceManager.contents,
      themes
    );
    factory.widgetCreated.connect((_sender, widget) => {
      widget.title.icon = listIcon;
      widget.context.pathChanged.connect(() => {
        void inventories.save(widget).catch(error => {
          console.warn(
            'Could not save the lightcone lab document layout.',
            error
          );
        });
      }, widget);
      void inventories.add(widget).catch(error => {
        console.warn('Could not track the lightcone lab document.', error);
      });
    });
    app.docRegistry.addWidgetFactory(factory);
    registerCommands({
      app,
      documents,
      themes,
      browser,
      papers,
      translator: translator ?? undefined,
      publicationUrl: () => {
        const value = settings?.get('publicationUrl').composite;
        return typeof value === 'string' ? value : '';
      }
    });
    if (restorer) {
      void restorer.restore(inventories, {
        command: 'docmanager:open',
        args: widget => ({
          path: widget.context.path,
          factory: INVENTORY_FACTORY
        }),
        name: widget => widget.context.path
      });
      void restorer.restore(papers, {
        command: CommandIDs.openPaper,
        args: widget => ({
          path: widget.content.entrypoint,
          url: widget.content.url
        }),
        name: widget => `${widget.content.entrypoint}:${widget.content.url}`
      });
    }
    for (const [rank, command] of [
      CommandIDs.openInventory,
      CommandIDs.openPaper
    ].entries()) {
      palette?.addItem({ command, category: CATEGORY });
      launcher?.add({ command, category: CATEGORY, rank });
    }
    palette?.addItem({ command: CommandIDs.refresh, category: CATEGORY });
  }
};

export default [plugin, themePlugin];
