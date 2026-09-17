import { CommandRegistry } from '@lumino/commands';
import type { IThemeManager } from '@jupyterlab/apputils';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ContentsManager } from '@jupyterlab/services';
import {
  ASTRA_FILE_PATTERN,
  ASTRA_FILE_TYPE,
  INVENTORY_FACTORY,
  InventoryDocumentFactory
} from '../document-widget';

jest.mock('../inventory-panel', () => ({ AstraInventoryPanel: jest.fn() }));

describe('inventory document registration', () => {
  it('chooses the inventory for ASTRA entrypoints on default and configured drives', () => {
    const registry = new DocumentRegistry();
    const contents = new ContentsManager();
    registry.addFileType({
      name: ASTRA_FILE_TYPE,
      extensions: [],
      pattern: ASTRA_FILE_PATTERN,
      contentType: 'file',
      fileFormat: 'text'
    });
    registry.addWidgetFactory(
      new InventoryDocumentFactory(
        contents,
        {} as IThemeManager,
        new CommandRegistry()
      )
    );
    try {
      for (const path of [
        'astra.yaml',
        'work/astra.yaml',
        'archive:astra.yaml',
        'archive:work/astra.yaml'
      ]) {
        expect(registry.defaultWidgetFactory(path)?.name).toBe(
          INVENTORY_FACTORY
        );
      }
      for (const path of [
        'other.yaml',
        'archive:other.yaml',
        'work/not-astra.yaml'
      ]) {
        expect(registry.defaultWidgetFactory(path)?.name).not.toBe(
          INVENTORY_FACTORY
        );
      }
    } finally {
      registry.dispose();
      contents.dispose();
    }
  });
});
