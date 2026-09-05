import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { Widget } from '@lumino/widgets';
import { loadProject, projectErrorMessage } from './project-data';
import type { ProjectContents } from './project-reader';

export const ASTRA_FILE_TYPE = 'astra-analysis';
export const LIGHTCONE_WIDGET_FACTORY = 'Lightcone Viewer';

/** A read-only validation view backed by JupyterLab's existing text context. */
export class LightconeDocumentWidget extends DocumentWidget {
  constructor(
    context: DocumentRegistry.Context,
    private readonly _contents: ProjectContents
  ) {
    super({ context, content: new Widget() });
    this.content.addClass('jp-jupyterlab-lightcone-Document');
    this.content.node.setAttribute(
      'aria-label',
      this._trans.__('Lightcone project validation')
    );
    this.content.node.tabIndex = 0;
    context.pathChanged.connect(this._onProjectPathChanged, this);
    this._show('Loading ASTRA project…');
    void this._load();
  }

  /** Invalidate pending loads and release the context subscription. */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._generation++;
    this.context.pathChanged.disconnect(this._onProjectPathChanged, this);
    super.dispose();
  }

  private _onProjectPathChanged(): void {
    void this._load();
  }

  private async _load(): Promise<void> {
    const generation = ++this._generation;
    this._show('Loading ASTRA project…');
    try {
      await this.context.ready;
      if (this.isDisposed || generation !== this._generation) {
        return;
      }
      const path = this.context.path;
      const project = await loadProject(this._contents, path);
      if (this.isDisposed || generation !== this._generation) {
        return;
      }
      this._show(
        `${project.document.analysis.name}\nValid ASTRA project\n${path}\nUniverse: ${project.document.universe.universeId}\nAnalyses: ${project.index.analysisByPath.size}\nRecords: ${project.index.recordByPath.size}`
      );
    } catch (error) {
      if (!this.isDisposed && generation === this._generation) {
        this._show(
          `Could not open ${this.context.path}\n${projectErrorMessage(error)}`,
          true
        );
      }
    }
  }

  private _show(message: string, error = false): void {
    this.content.node.setAttribute('role', error ? 'alert' : 'status');
    this.content.node.textContent = message;
  }

  private _generation = 0;
}

/** Register a viewer without starting kernels or changing the shared text model. */
export class LightconeDocumentWidgetFactory extends ABCWidgetFactory<LightconeDocumentWidget> {
  constructor(private readonly _contents: ProjectContents) {
    super({
      name: LIGHTCONE_WIDGET_FACTORY,
      fileTypes: [ASTRA_FILE_TYPE],
      defaultFor: [],
      modelName: 'text',
      readOnly: true,
      preferKernel: false,
      canStartKernel: false
    });
  }

  protected createNewWidget(
    context: DocumentRegistry.Context
  ): LightconeDocumentWidget {
    return new LightconeDocumentWidget(context, this._contents);
  }
}
