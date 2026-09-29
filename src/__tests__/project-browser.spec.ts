import type { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServiceManagerMock } from '@jupyterlab/services/lib/testutils';
import { Signal } from '@lumino/signaling';
import { projectFolders } from '../api';
import { browseProjectFolder } from '../project-browser';
import { withLightconeServer } from './server-fixtures';

jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  projectFolders: jest.fn()
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Open the picker at the root, where `project` and `plain` are folders, and
 * return the listed names and whether each shows the project badge.
 */
async function openPicker(
  services: InstanceType<typeof ServiceManagerMock>,
  project: string,
  plain: string
): Promise<Map<string, boolean>> {
  // Only what the native file browser reads from its document manager.
  const manager = {
    services,
    registry: new DocumentRegistry(),
    activateRequested: new Signal<object, string>({})
  } as unknown as IDocumentManager;
  const chosen = browseProjectFolder(manager, '');
  const listed = new Map<string, boolean>();
  try {
    // The listing ignores the first model refresh: it is hidden until the
    // dialog opens. Badges follow the listing once its lookup settles.
    for (let attempt = 0; attempt < 50; attempt++) {
      await flush();
      const items = Array.from(
        document.querySelectorAll('.jp-Dialog .jp-DirListing-item')
      );
      listed.clear();
      for (const item of items) {
        const name = item.querySelector('.jp-DirListing-itemText')?.textContent;
        listed.set(
          name ?? '',
          item.querySelector('.jp-jupyterlab-lightcone-ProjectBadge') !== null
        );
      }
      if (listed.get(project) && listed.has(plain)) break;
    }
  } finally {
    // Disposing a dialog rejects its promise; cancelling settles it.
    document
      .querySelector<HTMLElement>('.jp-Dialog button.jp-mod-reject')
      ?.click();
    expect(await chosen).toBeUndefined();
  }
  return listed;
}

describe('with Lightcone’s server', () => {
  withLightconeServer();

  it('lists and labels the starting folder before any navigation', async () => {
    const services = new ServiceManagerMock();
    const project = await services.contents.newUntitled({ type: 'directory' });
    const plain = await services.contents.newUntitled({ type: 'directory' });
    jest.mocked(projectFolders).mockResolvedValue([project.path]);
    const listed = await openPicker(services, project.name, plain.name);
    expect(projectFolders).toHaveBeenCalledWith(expect.anything(), '');
    expect(listed.get(project.name)).toBe(true);
    expect(listed.get(plain.name)).toBe(false);
  });
});

describe('in the browser only', () => {
  beforeEach(() => jest.mocked(projectFolders).mockClear());

  it('labels the folders holding astra.yaml through the Contents API', async () => {
    const services = new ServiceManagerMock();
    const project = await services.contents.newUntitled({ type: 'directory' });
    const plain = await services.contents.newUntitled({ type: 'directory' });
    await services.contents.save(`${project.path}/astra.yaml`, {
      type: 'file',
      format: 'text',
      content: 'name: Project\n'
    });
    const listed = await openPicker(services, project.name, plain.name);
    expect(projectFolders).not.toHaveBeenCalled();
    expect(listed.get(project.name)).toBe(true);
    expect(listed.get(plain.name)).toBe(false);
  });
});
