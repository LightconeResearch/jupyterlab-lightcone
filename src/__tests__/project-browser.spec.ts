import type { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServiceManagerMock } from '@jupyterlab/services/lib/testutils';
import { Signal } from '@lumino/signaling';
import { projectFolders } from '../api';
import { browseProjectFolder } from '../project-browser';

jest.mock('../api', () => ({ projectFolders: jest.fn() }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('lists and labels the starting folder before any navigation', async () => {
  const services = new ServiceManagerMock();
  const folder = await services.contents.newUntitled({ type: 'directory' });
  jest.mocked(projectFolders).mockResolvedValue([folder.path]);
  // Only what the native file browser reads from its document manager.
  const manager = {
    services,
    registry: new DocumentRegistry(),
    activateRequested: new Signal<object, string>({})
  } as unknown as IDocumentManager;
  const chosen = browseProjectFolder(manager, '');
  try {
    // The listing ignores the first model refresh: it is hidden until the dialog opens.
    let items: Element[] = [];
    for (let attempt = 0; attempt < 50 && !items.length; attempt++) {
      await flush();
      items = Array.from(
        document.querySelectorAll('.jp-Dialog .jp-DirListing-item')
      );
    }
    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining(folder.name)
    ]);
    expect(
      items[0].querySelector('.jp-jupyterlab-lightcone-ProjectBadge')
    ).not.toBeNull();
  } finally {
    // Disposing a dialog rejects its promise; cancelling settles it.
    document
      .querySelector<HTMLElement>('.jp-Dialog button.jp-mod-reject')
      ?.click();
    expect(await chosen).toBeUndefined();
  }
});
