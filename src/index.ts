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
import { chatPlugin } from './chat-plugin';
import { astraMimePlugin } from './astra-mime';
import { registerElementCommands } from './element-commands';
import { astraIcon } from './icons';
import { CommandIDs, registerCommands } from './commands';
import {
  ASTRA_FILE_TYPE,
  ASTRA_FILE_PATTERN,
  INVENTORY_FACTORY,
  InventoryDocument,
  InventoryDocumentFactory
} from './document-widget';

const PLUGIN_ID = 'jupyterlab_lightcone:plugin';
const CATEGORY = 'Lightcone Lab';

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
    ILabShell
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
    shell: ILabShell | null
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
      themes
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
    registerElementCommands(app, themes, restorer, shell);
    palette?.addItem({ command: CommandIDs.pinElement, category: CATEGORY });
    palette?.addItem({ command: CommandIDs.unpinElement, category: CATEGORY });
    registerCommands({
      app,
      documents,
      browser,
      translator: translator ?? undefined
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
    }
    palette?.addItem({ command: CommandIDs.openInventory, category: CATEGORY });
    launcher?.add({
      command: CommandIDs.openInventory,
      category: CATEGORY,
      categoryRank: -10,
      rank: 1
    });
    palette?.addItem({ command: CommandIDs.refresh, category: CATEGORY });
    palette?.addItem({ command: CommandIDs.openMySTRA, category: CATEGORY });
    palette?.addItem({ command: CommandIDs.restartMySTRA, category: CATEGORY });
    launcher?.add({
      command: CommandIDs.openMySTRA,
      category: CATEGORY,
      categoryRank: -10,
      rank: 2
    });
    app.contextMenu.addItem({
      command: CommandIDs.openMySTRA,
      selector: '.jp-DirListing-item',
      args: { fromContextMenu: true },
      rank: 20
    });
  }
};

export default [plugin, astraMimePlugin, chatPlugin];
