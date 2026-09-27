import type { IDocumentOpener } from './artifact-access';
import type { IThemeManager } from '@jupyterlab/apputils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import type { Contents } from '@jupyterlab/services';
import type { ISignal } from '@lumino/signaling';
import type { ILightconeView } from './workbench-view';
import { AstraInventoryPanel } from './inventory-panel';

export const ASTRA_FILE_TYPE = 'astra-analysis';
// Jupyter's basename retains the drive prefix for a file at a drive root.
export const ASTRA_FILE_PATTERN = '^(?:[^/:]+:)?astra\\.yaml$';
export const INVENTORY_FACTORY = 'Lightcone Lab';

/** Read-only inventory backed by JupyterLab's ordinary text document context. */
export class InventoryDocument
  extends DocumentWidget<AstraInventoryPanel>
  implements ILightconeView
{
  constructor(
    context: DocumentRegistry.Context,
    contents: Contents.IManager,
    themeManager: IThemeManager,
    documents: IDocumentOpener
  ) {
    super({
      context,
      content: new AstraInventoryPanel(contents, themeManager, documents)
    });
    this.addClass('jp-jupyterlab-lightcone-Document');
    context.pathChanged.connect(this._onProjectPathChanged, this);
    context.saveState.connect(this._onProjectSaveState, this);
    void context.ready
      .then(() => this._display())
      .catch(error => {
        console.error('Could not open the Lightcone Lab document.', error);
      });
  }

  readonly lightconeView = true as const;

  /** The project's `astra.yaml`: the document itself. */
  get entrypoint(): string {
    return this.context.path;
  }

  /** The analysis the inventory shows, once the project has loaded. */
  get analysisPath(): string | undefined {
    return this.content.analysisPath;
  }

  /** Emitted when the inventory moves to another analysis. */
  get scopeChanged(): ISignal<AstraInventoryPanel, void> {
    return this.content.scopeChanged;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.context.pathChanged.disconnect(this._onProjectPathChanged, this);
    this.context.saveState.disconnect(this._onProjectSaveState, this);
    super.dispose();
  }

  private _onProjectPathChanged(): void {
    void this._display();
  }

  private _onProjectSaveState(
    _context: DocumentRegistry.Context,
    state: DocumentRegistry.SaveState
  ): void {
    if (state === 'completed') {
      void this.content.refresh();
    }
  }

  private async _display(): Promise<void> {
    if (!this.isDisposed) {
      try {
        await this.content.display({}, this.context.path);
      } catch (error) {
        // The inventory renders validation and access errors within the document.
        if (!this.isDisposed) {
          console.warn('Could not load the ASTRA inventory.', error);
        }
      }
    }
  }
}

/** Reuse the text model; opening an inventory never creates a kernel. */
export class InventoryDocumentFactory extends ABCWidgetFactory<InventoryDocument> {
  constructor(
    private readonly _contents: Contents.IManager,
    private readonly _themes: IThemeManager,
    private readonly _documents: IDocumentOpener
  ) {
    super({
      name: INVENTORY_FACTORY,
      label: INVENTORY_FACTORY,
      fileTypes: [ASTRA_FILE_TYPE],
      defaultFor: [ASTRA_FILE_TYPE],
      modelName: 'text',
      readOnly: true,
      preferKernel: false,
      canStartKernel: false
    });
  }

  protected createNewWidget(
    context: DocumentRegistry.Context
  ): InventoryDocument {
    return new InventoryDocument(
      context,
      this._contents,
      this._themes,
      this._documents
    );
  }
}
