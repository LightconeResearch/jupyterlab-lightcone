import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager, showErrorMessage } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { Widget } from '@lumino/widgets';
import {
  ArtifactPreview,
  RecordPreview,
  type ArtifactRenderer
} from '@astra-spec/ui/components';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { resolveElement } from './element-reference';
import { useProject } from './element-widget';
import { isRootAnalysisOutput } from './materialization-status';
import type { ILoadedProjectData } from './project-data';
import { useProjectRenderers } from './project-renderers';
import { LightconeThemeBinding } from './theme-adapter';
import { CommandIDs } from './commands';
import {
  ASTRA_MIME_TYPE,
  parseAstraCard,
  type IAstraCard,
  type IAstraCardVersion
} from './astra-mime-data';
import { listVersionsCached } from './versions/version-cache';
import type { IVersionTarget } from './versions/version-content';
import { OlderVersionPreview } from './versions/versioned-output';
import type { IOutputVersion } from './versions/versions-api';

interface ICardProps {
  app: JupyterFrontEnd;
  themes: IThemeManager;
  reference: IAstraCard;
}

function Card({ app, themes, reference }: ICardProps): React.ReactElement {
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
        <CardBody {...{ app, reference, state }} />
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

/** How a card's recorded version relates to the output's history. */
export type CardVersionState = 'unknown' | 'latest' | 'superseded' | 'missing';

/** The version of a newest-first history a card's commit names, if any. */
export function findCardVersion(
  version: IAstraCardVersion,
  versions: readonly IOutputVersion[]
): IOutputVersion | undefined {
  return versions.find(
    candidate =>
      candidate.commit === version.commit ||
      candidate.commit.startsWith(version.commit)
  );
}

/** Compare a card's commit with the newest-first history of its output. */
export function cardVersionState(
  version: IAstraCardVersion,
  versions: readonly IOutputVersion[] | undefined
): CardVersionState {
  if (!versions) return 'unknown';
  const recorded = findCardVersion(version, versions);
  if (!recorded) return 'missing';
  return recorded === versions[0] ? 'latest' : 'superseded';
}

const CARD_VERSION_TEXT: Record<CardVersionState, string> = {
  unknown: '',
  latest: 'latest',
  superseded: 'newer available',
  missing: 'not in the current history'
};

/** The history of a card's output; `settled` once the listing answered or failed. */
function useCardVersions(target: IVersionTarget | undefined): {
  versions?: readonly IOutputVersion[];
  settled: boolean;
} {
  const [listing, setListing] = useState<{
    target?: IVersionTarget;
    versions?: readonly IOutputVersion[];
  }>({});
  useEffect(() => {
    if (!target) return;
    let active = true;
    listVersionsCached(
      target.settings,
      target.entrypoint,
      target.universe,
      target.outputId
    ).then(
      result => {
        if (active) setListing({ target, versions: result.versions });
      },
      () => {
        if (active) setListing({ target });
      }
    );
    return () => {
      active = false;
    };
  }, [target]);
  const current = !!target && listing.target === target;
  return {
    versions: current ? listing.versions : undefined,
    settled: !target || current
  };
}

export interface IVersionedCardProps {
  app: JupyterFrontEnd;
  reference: IAstraCard;
  /** The version the card was made from. */
  version: IAstraCardVersion;
  data: ILoadedProjectData;
  /** The output the card shows. */
  output: ResolvedOutput;
  /** How the host renders an output's current artifact. */
  renderArtifact: ArtifactRenderer | undefined;
  /** Render the card's preview with the given artifact renderer. */
  renderPreview: (renderArtifact: ArtifactRenderer) => React.ReactNode;
  onOpen: () => void;
}

/**
 * A card made from a committed version of an output: it shows that version's
 * bytes while newer ones exist, so that a card from an earlier turn still
 * shows what the agent showed then, and a chip says how the version relates
 * to the output's history. A version the history does not hold, or a
 * history that cannot be read, shows the current artifact.
 */
export function VersionedCard({
  app,
  reference,
  version,
  data,
  output,
  renderArtifact,
  renderPreview,
  onOpen
}: IVersionedCardProps): React.ReactElement {
  const contents = app.serviceManager.contents;
  const comparable =
    isRootAnalysisOutput(data.index, output) &&
    !contents.driveName(reference.entrypoint);
  const settings = contents.serverSettings;
  const universe = data.document.universe.universeId;
  const target = useMemo<IVersionTarget | undefined>(
    () =>
      comparable
        ? {
            settings,
            entrypoint: reference.entrypoint,
            universe,
            outputId: output.id
          }
        : undefined,
    [comparable, settings, reference.entrypoint, universe, output.id]
  );
  const { versions, settled } = useCardVersions(target);
  const state = cardVersionState(version, versions);
  const recorded =
    state === 'superseded' && versions
      ? findCardVersion(version, versions)
      : undefined;
  const detail = CARD_VERSION_TEXT[state];
  const renderVersioned: ArtifactRenderer = (item, options) => {
    if (!target || item.canonicalPath !== output.canonicalPath)
      return renderArtifact?.(item, options) ?? null;
    if (!settled) {
      return (
        <ArtifactPreview
          output={item}
          preview={{ kind: 'loading' }}
          compact={options.compact}
          caption={null}
        />
      );
    }
    return recorded ? (
      <OlderVersionPreview
        target={target}
        output={item}
        version={recorded}
        compact={options.compact}
      />
    ) : (
      (renderArtifact?.(item, options) ?? null)
    );
  };
  return (
    <>
      {renderPreview(renderVersioned)}
      <button
        type="button"
        className="jp-jupyterlab-lightcone-card-version"
        data-state={state}
        title={`Open ${output.label ?? output.id} as it was at ${version.commit}`}
        onClick={onOpen}
      >
        <span>Version {version.commit.slice(0, 7)}</span>
        {detail && (
          <>
            <span aria-hidden="true"> · </span>
            <span>{detail}</span>
          </>
        )}
      </button>
    </>
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
    app.commands
  );
  let resolved: ReturnType<typeof resolveElement>;
  try {
    resolved = resolveElement(data, reference.target);
  } catch (reason) {
    return (
      <p role="status">This ASTRA element is unavailable: {String(reason)}</p>
    );
  }
  const { outputVersion, ...pinnedReference } = reference;
  const navigate = (target: string, pinned = false) => {
    void app.commands
      .execute(CommandIDs.openElement, {
        ...pinnedReference,
        target,
        pinned,
        // A card shows what the agent showed; its version travels with it.
        ...(outputVersion && target === reference.target
          ? { versionCommit: outputVersion.commit }
          : {})
      })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', reason)
      );
  };
  const preview = (renderArtifact: ArtifactRenderer | undefined) => (
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
      renderArtifact={renderArtifact}
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
  if (!outputVersion || resolved.record?.kind !== 'output')
    return preview(renderers.renderArtifact);
  return (
    <VersionedCard
      app={app}
      reference={reference}
      version={outputVersion}
      data={data}
      output={resolved.record}
      renderArtifact={renderers.renderArtifact}
      renderPreview={preview}
      onOpen={() => navigate(reference.target)}
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
    private readonly themes: IThemeManager
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
  requires: [IRenderMimeRegistry, IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    registry: IRenderMimeRegistry,
    themes: IThemeManager
  ) => {
    if (!customElements.get('lightcone-astra-card'))
      customElements.define('lightcone-astra-card', AstraCardElement);
    registry.addFactory(
      {
        // Only validated references are accepted. Renderers load through Jupyter's
        // authenticated Contents API; no HTML, scripts or arbitrary URLs execute.
        safe: true,
        mimeTypes: [ASTRA_MIME_TYPE],
        createRenderer: () => new AstraMimeRenderer(app, themes)
      },
      40
    );
  }
};
