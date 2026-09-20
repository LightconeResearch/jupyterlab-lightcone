import { Dialog, showDialog } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import {
  DirListing,
  FileBrowser,
  FilterFileBrowserModel
} from '@jupyterlab/filebrowser';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { PanelLayout, Widget } from '@lumino/widgets';
import { projectFolders } from './api';

/** Preserve native folder navigation while labeling recognized projects. */
class ProjectFolderRenderer extends DirListing.Renderer {
  projects = new Set<string>();

  updateItemNode(
    ...args: Parameters<DirListing.Renderer['updateItemNode']>
  ): void {
    super.updateItemNode(...args);
    const [node, model] = args;
    node.querySelector('.jp-jupyterlab-lightcone-ProjectBadge')?.remove();
    if (this.projects.has(model.path)) {
      const badge = document.createElement('span');
      badge.className = 'jp-jupyterlab-lightcone-ProjectBadge';
      badge.textContent = 'ASTRA project';
      badge.title = 'Contains astra.yaml';
      node.querySelector('.jp-DirListing-itemText')?.after(badge);
    }
  }
}

class ProjectFileBrowser extends FileBrowser {
  /**
   * Re-read the model's items as well as repainting the badges. The listing
   * skips a model refresh while hidden, as it is before the dialog opens, so
   * a plain `update()` would leave the first folder empty.
   */
  refreshMarkers(): void {
    this.listing.sort(this.listing.sortState);
  }
}

class ProjectBrowserBody extends Widget {
  private generation = 0;
  private status = new Widget();

  constructor(
    private browser: ProjectFileBrowser,
    private renderer: ProjectFolderRenderer,
    private manager: IDocumentManager
  ) {
    super();
    this.addClass('jp-jupyterlab-lightcone-ProjectBrowser');
    const layout = (this.layout = new PanelLayout());
    this.status.node.setAttribute('role', 'status');
    layout.addWidget(this.status);
    layout.addWidget(browser);
    browser.model.refreshed.connect(this.refresh, this);
    void this.refresh();
  }

  getValue(): string {
    return (
      [...this.browser.selectedItems()][0]?.path ?? this.browser.model.path
    );
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    const contents = this.manager.services.contents;
    let paths: string[] = [];
    let status: string;
    if (contents.driveName(this.browser.model.path)) {
      status =
        'Select a project folder to open it. Project badges are available on the local drive.';
    } else {
      try {
        paths = await projectFolders(
          contents.serverSettings,
          this.browser.model.path
        );
        status = 'ASTRA project labels mark folders containing astra.yaml.';
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.isDisposed || generation !== this.generation) return;
    this.renderer.projects = new Set(paths);
    this.status.node.textContent = status;
    this.browser.refreshMarkers();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.browser.model.refreshed.disconnect(this.refresh, this);
    super.dispose();
  }
}

/** Native Jupyter directory picker with shallow ASTRA project recognition. */
export async function browseProjectFolder(
  manager: IDocumentManager,
  path: string,
  translator: ITranslator = nullTranslator
): Promise<string | undefined> {
  const model = new FilterFileBrowserModel({
    manager,
    driveName: manager.services.contents.driveName(path),
    auto: false,
    filter: item => (item.type === 'directory' ? {} : null),
    filterDirectories: true
  });
  const renderer = new ProjectFolderRenderer();
  const browser = new ProjectFileBrowser({
    id: 'lightcone-project-browser',
    model,
    renderer,
    translator,
    restore: false
  });
  browser.clearFilterOnNavigation = false;
  try {
    await model.cd(`/${manager.services.contents.localPath(path)}`);
    const result = await showDialog({
      title: 'Choose a project folder',
      body: new ProjectBrowserBody(browser, renderer, manager),
      buttons: [
        Dialog.cancelButton(),
        Dialog.okButton({ label: 'Select folder' })
      ]
    });
    return result.button.accept ? (result.value ?? undefined) : undefined;
  } finally {
    browser.dispose();
    model.dispose();
  }
}
