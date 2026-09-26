import { IDocumentManager } from '@jupyterlab/docmanager';
import type { IDocumentOpener } from './artifact-access';
import React, { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager, showErrorMessage } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { Widget } from '@lumino/widgets';
import { RecordPreview } from '@astra-spec/ui/components';
import { resolveElement } from './element-reference';
import { useProject } from './project-data-hooks';
import { useProjectRenderers } from './project-renderers';
import { LightconeThemeBinding } from './theme-adapter';
import { CommandIDs } from './commands';
import {
  ASTRA_MIME_TYPE,
  parseAstraCard,
  type IAstraCard
} from './astra-mime-data';

interface ICardProps {
  documents: IDocumentOpener;
  app: JupyterFrontEnd;
  themes: IThemeManager;
  reference: IAstraCard;
}

function Card({
  app,
  themes,
  reference,
  documents
}: ICardProps): React.ReactElement {
  const node = useRef<HTMLDivElement>(null);
  const state = useProject(app.serviceManager.contents, reference);
  useEffect(() => {
    const binding = new LightconeThemeBinding(themes, node.current!);
    return () => binding.dispose();
  }, [themes]);
  return (
    <div
      ref={node}
      className="astra-ui astra-isolate lightcone-brand jp-jupyterlab-lightcone-card"
    >
      {state.error && <p role="status">{state.error}</p>}
      {state.data ? (
        <CardBody {...{ app, reference, state, documents }} />
      ) : (
        <p>
          {state.error
            ? 'This ASTRA element is unavailable.'
            : 'Loading ASTRA preview…'}
        </p>
      )}
    </div>
  );
}

/** Let embedded links and controls handle their own pointer gestures. */
function isCardContentEvent(event: React.MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || !(event.target instanceof Element))
    return false;
  const control = event.target.closest(
    'a, button, input, select, textarea, summary, audio, video, [role="button"], [role="link"], [tabindex], [contenteditable]:not([contenteditable="false"])'
  );
  return !control || control === event.currentTarget;
}

function CardBody({
  documents,
  app,
  reference,
  state
}: Omit<ICardProps, 'themes'> & {
  state: ReturnType<typeof useProject>;
}): React.ReactElement {
  const data = state.data!;
  const renderers = useProjectRenderers(
    app.serviceManager.contents,
    reference.entrypoint,
    data,
    state.fetchPaper,
    documents
  );
  let resolved: ReturnType<typeof resolveElement>;
  try {
    resolved = resolveElement(data, reference.target);
  } catch (reason) {
    return (
      <p role="status">This ASTRA element is unavailable: {String(reason)}</p>
    );
  }
  const navigate = (target: string, pinned = false) => {
    void app.commands
      .execute(CommandIDs.openElement, { ...reference, target, pinned })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', reason)
      );
  };
  return (
    <RecordPreview
      className="jp-jupyterlab-lightcone-card-preview"
      role="link"
      tabIndex={0}
      aria-label={`Open ${resolved.record?.label || reference.target || 'analysis'} in a tab`}
      onClick={event => {
        if (
          isCardContentEvent(event) &&
          !event.currentTarget.ownerDocument.getSelection()?.toString()
        )
          navigate(reference.target);
      }}
      onDoubleClick={event => {
        if (isCardContentEvent(event)) navigate(reference.target, true);
      }}
      onKeyDown={event => {
        if (
          event.target === event.currentTarget &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault();
          navigate(reference.target);
        }
      }}
      entry={
        resolved.record
          ? {
              kind: 'record',
              record: resolved.record,
              analysis: resolved.analysis
            }
          : { kind: 'analysis', analysis: resolved.analysis }
      }
      document={data.document}
      index={data.index}
      renderArtifact={renderers.renderArtifact}
      onOpenRecord={record => navigate(record.canonicalPath)}
      onOpenAnalysis={() =>
        navigate(
          resolved.analysis.canonicalPath === '$'
            ? ''
            : resolved.analysis.canonicalPath
        )
      }
    />
  );
}

/** Chat 0.25 mounts only a MIME widget's DOM node, without disposing the widget.
 * A custom element gives React (and its project leases) actual DOM lifecycles,
 * including message deletion, rerendering and closing the chat.
 */
export class AstraCardElement extends HTMLElement {
  content: React.ReactElement | null = null;
  private _root?: Root;

  connectedCallback(): void {
    this._root ??= createRoot(this);
    this.update();
  }

  disconnectedCallback(): void {
    // React may remove this node during its own commit. Defer unmounting until
    // that commit completes, and retain the root if the node was only moved.
    queueMicrotask(() => {
      if (!this.isConnected) this.clear();
    });
  }

  update(): void {
    this._root?.render(this.content);
  }
  clear(): void {
    this._root?.unmount();
    this._root = undefined;
  }
}

/** Native RenderMime integration, independent of Chat's Markdown renderer. */
export class AstraMimeRenderer extends Widget implements IRenderMime.IRenderer {
  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly themes: IThemeManager,
    private readonly documents: IDocumentOpener
  ) {
    super({ node: document.createElement('lightcone-astra-card') });
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const node = this.node as AstraCardElement;
    try {
      const reference = parseAstraCard(model.data[ASTRA_MIME_TYPE]);
      node.content = (
        <Card
          key={JSON.stringify(reference)}
          app={this.app}
          themes={this.themes}
          documents={this.documents}
          reference={reference}
        />
      );
    } catch (reason) {
      node.content = <p role="status">{String(reason)}</p>;
    }
    node.update();
  }

  dispose(): void {
    if (this.isDisposed) return;
    (this.node as AstraCardElement).clear();
    super.dispose();
  }
}

export const astraMimePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:astra-mime',
  description: 'Render ASTRA preview cards in MIME messages and outputs.',
  autoStart: true,
  requires: [IRenderMimeRegistry, IThemeManager, IDocumentManager],
  activate: (
    app: JupyterFrontEnd,
    registry: IRenderMimeRegistry,
    themes: IThemeManager,
    documents: IDocumentManager
  ) => {
    if (!customElements.get('lightcone-astra-card'))
      customElements.define('lightcone-astra-card', AstraCardElement);
    registry.addFactory(
      {
        // Only validated references are accepted. Renderers load through Jupyter's
        // authenticated Contents API; no HTML, scripts or arbitrary URLs execute.
        safe: true,
        mimeTypes: [ASTRA_MIME_TYPE],
        createRenderer: () => new AstraMimeRenderer(app, themes, documents)
      },
      40
    );
  }
};
