import type { JupyterFrontEnd } from '@jupyterlab/application';
import {
  WidgetTracker,
  MainAreaWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ContentsManager, Drive } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { CommandIDs, registerCommands } from '../commands';
import { InventoryDocument } from '../document-widget';
import { PaperPanel } from '../paper-panel';
import { fileModel } from './project-fixtures';

jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../open-reference', () => ({
  parseInventoryOpenReference: jest.fn().mockReturnValue(undefined)
}));
jest.mock('../document-widget', () => {
  const { Widget } =
    jest.requireActual<typeof import('@lumino/widgets')>('@lumino/widgets');
  return {
    INVENTORY_FACTORY: 'Lightcone Lab',
    InventoryDocument: class extends Widget {
      constructor(readonly context: { path: string; ready: Promise<void> }) {
        super();
      }
      content = {
        display: jest.fn().mockResolvedValue(undefined),
        refresh: jest.fn().mockResolvedValue(undefined)
      };
    }
  };
});
jest.mock('../paper-panel', () => {
  const { Widget } =
    jest.requireActual<typeof import('@lumino/widgets')>('@lumino/widgets');
  return {
    PaperPanel: class extends Widget {
      entrypoint = 'astra.yaml';
      url = 'https://example.org/';
    }
  };
});

/** Only the command's host boundaries are mocked; Lumino commands and paths are real. */
function commandHost(browser: IFileBrowserFactory | null = null) {
  const contents = new ContentsManager();
  contents.addDrive(new Drive({ name: 'archive' }));
  const get = jest
    .spyOn(contents, 'get')
    .mockResolvedValue(fileModel('project'));
  const commands = new CommandRegistry();
  const shell = {
    currentWidget: null as Widget | null,
    activateById: jest.fn(),
    add: jest.fn()
  };
  const papers = new WidgetTracker<MainAreaWidget<PaperPanel>>({
    namespace: 'test-paper'
  });
  const created: InventoryDocument[] = [];
  const themes = {} as IThemeManager;
  const openOrReveal = jest.fn((path: string) => {
    const widget = new InventoryDocument(
      { path, ready: Promise.resolve() } as DocumentRegistry.Context,
      contents,
      themes
    );
    created.push(widget);
    return widget;
  });
  const contextForWidget = jest.fn();
  const documents = {
    openOrReveal,
    contextForWidget
  } as unknown as IDocumentManager;
  registerCommands({
    app: {
      commands,
      shell,
      serviceManager: { contents }
    } as unknown as JupyterFrontEnd,
    documents,
    themes,
    browser,
    papers,
    publicationUrl: () => ''
  });
  return {
    commands,
    contents,
    get,
    shell,
    openOrReveal,
    contextForWidget,
    themes,
    dispose: () => {
      created.forEach(widget => widget.dispose());
      contents.dispose();
      papers.dispose();
    }
  };
}

describe('project opening commands', () => {
  it('resolves the launcher directory on its registered drive', async () => {
    const host = commandHost();
    try {
      await host.commands.execute(CommandIDs.openInventory, {
        cwd: 'archive:project'
      });
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'archive:project/astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      host.dispose();
    }
  });

  it('uses the active document directory, including a contents drive root', async () => {
    const host = commandHost();
    const editor = new Widget();
    host.shell.currentWidget = editor;
    host.contextForWidget.mockReturnValue({ path: 'archive:notes.md' });
    try {
      await host.commands.execute(CommandIDs.openInventory);
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'archive:astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      editor.dispose();
      host.dispose();
    }
  });

  it('uses the selected ASTRA file when no document supplies a project', async () => {
    const browser = {
      tracker: {
        currentWidget: {
          selectedItems: () => [
            { name: 'astra.yaml', path: 'work/astra.yaml' }
          ],
          model: { path: 'other' }
        }
      }
    } as unknown as IFileBrowserFactory;
    const host = commandHost(browser);
    try {
      await host.commands.execute(CommandIDs.openInventory);
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'work/astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      host.dispose();
    }
  });

  it('displays the current context path when a document is renamed while opening', async () => {
    const host = commandHost();
    const ready = new PromiseDelegate<void>();
    const opened = new PromiseDelegate<void>();
    const context = { path: 'old/astra.yaml', ready: ready.promise };
    const widget = new InventoryDocument(
      context as DocumentRegistry.Context,
      host.contents,
      host.themes
    );
    host.openOrReveal.mockImplementation(() => {
      opened.resolve();
      return widget;
    });
    try {
      const pending = host.commands.execute(CommandIDs.openInventory, {
        path: context.path
      });
      await opened.promise;
      context.path = 'new/astra.yaml';
      ready.resolve();
      await pending;
      expect(widget.content.display).toHaveBeenCalledWith({}, 'new/astra.yaml');
    } finally {
      ready.resolve();
      widget.dispose();
      host.dispose();
    }
  });

  it('reports missing files without asking the document manager to create them', async () => {
    const host = commandHost();
    host.get.mockRejectedValue(new Error('Project missing'));
    try {
      expect(
        await host.commands.execute(CommandIDs.openInventory, {
          path: 'missing/astra.yaml'
        })
      ).toBeUndefined();
      expect(host.openOrReveal).not.toHaveBeenCalled();
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Could not open the ASTRA inventory',
        expect.any(Error)
      );
    } finally {
      host.dispose();
    }
  });
});
