import React, { useEffect, useId, useState } from 'react';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { Button } from '@astra-spec/ui/primitives';
import {
  absentReason,
  versionContentUrl,
  type IOutputVersion
} from './versions-api';
import {
  comparisonModeFor,
  readVersionJson,
  readVersionTableShape,
  type IVersionTarget
} from './version-content';
import {
  formatNumber,
  METRIC_LEAF_LIMIT,
  metricDeltas,
  versionFormat,
  tableShapeDiff,
  type IMetricComparison,
  type ITableShapeDiff
} from './version-model';
import { relativeTime } from '../relative-time';

export interface IVersionCompareProps {
  target: IVersionTarget;
  output: ResolvedOutput;
  /** The version being shown. */
  newer: IOutputVersion;
  /** The version made before it. */
  older: IOutputVersion;
}

function versionCaption(version: IOutputVersion, ordinal: string): string {
  return `${ordinal} · ${version.short} · ${relativeTime(version.time)}`;
}

function ImageSide({
  target,
  output,
  version,
  caption
}: {
  target: IVersionTarget;
  output: ResolvedOutput;
  version: IOutputVersion;
  caption: string;
}): React.ReactElement {
  return (
    <figure className="jp-jupyterlab-lightcone-VersionCompare-side">
      {version.present ? (
        <img
          src={versionContentUrl(
            target.settings,
            target.entrypoint,
            target.universe,
            target.outputId,
            version.commit
          )}
          alt={`${output.label ?? output.id} at ${version.short}`}
        />
      ) : (
        <p role="status">{absentReason(version)}</p>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** How two image versions are laid against each other. */
type ImageCompareMode = 'side' | 'swipe' | 'blink';

/** How long each version stays up while blinking, in ms. */
export const BLINK_INTERVAL = 700;

/**
 * Both versions stacked in one frame, alternating: a change shows as motion.
 * The alternation pauses while the pointer rests on the frame or the Pause
 * button holds it, so either version can be studied.
 */
function BlinkCompare({
  output,
  newer,
  older,
  newerUrl,
  olderUrl
}: {
  output: ResolvedOutput;
  newer: IOutputVersion;
  older: IOutputVersion;
  newerUrl: string;
  olderUrl: string;
}): React.ReactElement {
  const [showNewer, setShowNewer] = useState(true);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const running = !paused && !hovered;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => setShowNewer(value => !value),
      BLINK_INTERVAL
    );
    return () => window.clearInterval(timer);
  }, [running]);
  const shown = showNewer ? newer : older;
  return (
    <div className="jp-jupyterlab-lightcone-VersionCompare-blink">
      <div
        className="jp-jupyterlab-lightcone-VersionCompare-stack"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <img
          src={olderUrl}
          alt={`${output.label ?? output.id} at ${older.short}`}
          style={{ visibility: showNewer ? 'hidden' : 'visible' }}
        />
        <img
          src={newerUrl}
          alt={`${output.label ?? output.id} at ${newer.short}`}
          style={{ visibility: showNewer ? 'visible' : 'hidden' }}
        />
      </div>
      <div className="jp-jupyterlab-lightcone-VersionCompare-blinkControls">
        <span
          className="jp-jupyterlab-lightcone-VersionCompare-blinkLabel"
          role="status"
        >
          {versionCaption(shown, showNewer ? 'Shown' : 'Previous')}
        </span>
        <Button
          size="small"
          variant="quiet"
          aria-pressed={paused}
          onClick={() => setPaused(value => !value)}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          size="small"
          variant="quiet"
          onClick={() => {
            setPaused(true);
            setShowNewer(value => !value);
          }}
        >
          {showNewer ? 'Show previous' : 'Show newer'}
        </Button>
      </div>
    </div>
  );
}

function ImageCompare({
  target,
  output,
  newer,
  older
}: IVersionCompareProps): React.ReactElement {
  const [mode, setMode] = useState<ImageCompareMode>('side');
  const [split, setSplit] = useState(50);
  const sliderId = useId();
  const url = (version: IOutputVersion) =>
    versionContentUrl(
      target.settings,
      target.entrypoint,
      target.universe,
      target.outputId,
      version.commit
    );
  const swipeable = newer.present && older.present;
  return (
    <div className="jp-jupyterlab-lightcone-VersionCompare-images">
      <div
        className="jp-jupyterlab-lightcone-VersionCompare-modes"
        role="group"
        aria-label="Comparison mode"
      >
        <Button
          size="small"
          variant={mode === 'side' ? 'secondary' : 'quiet'}
          aria-pressed={mode === 'side'}
          onClick={() => setMode('side')}
        >
          Side by side
        </Button>
        <Button
          size="small"
          variant={mode === 'swipe' ? 'secondary' : 'quiet'}
          aria-pressed={mode === 'swipe'}
          disabled={!swipeable}
          onClick={() => setMode('swipe')}
        >
          Swipe
        </Button>
        <Button
          size="small"
          variant={mode === 'blink' ? 'secondary' : 'quiet'}
          aria-pressed={mode === 'blink'}
          disabled={!swipeable}
          onClick={() => setMode('blink')}
        >
          Blink
        </Button>
      </div>
      {mode === 'blink' && swipeable ? (
        <BlinkCompare
          output={output}
          newer={newer}
          older={older}
          newerUrl={url(newer)}
          olderUrl={url(older)}
        />
      ) : mode === 'side' || !swipeable ? (
        <div className="jp-jupyterlab-lightcone-VersionCompare-pair">
          <ImageSide
            target={target}
            output={output}
            version={older}
            caption={versionCaption(older, 'Previous')}
          />
          <ImageSide
            target={target}
            output={output}
            version={newer}
            caption={versionCaption(newer, 'Shown')}
          />
        </div>
      ) : (
        <div className="jp-jupyterlab-lightcone-VersionCompare-swipe">
          <div className="jp-jupyterlab-lightcone-VersionCompare-stack">
            <img
              src={url(older)}
              alt={`${output.label ?? output.id} at ${older.short}`}
              style={{ clipPath: `inset(0 0 0 ${split}%)` }}
            />
            <img
              src={url(newer)}
              alt={`${output.label ?? output.id} at ${newer.short}`}
              style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
            />
            <span
              className="jp-jupyterlab-lightcone-VersionCompare-divider"
              style={{ left: `${split}%` }}
              aria-hidden="true"
            />
          </div>
          <label htmlFor={sliderId}>
            <span>{versionCaption(newer, 'Shown')}</span>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={100}
              value={split}
              onChange={event => setSplit(Number(event.target.value))}
              aria-label="Reveal the shown version from the left"
            />
            <span>{versionCaption(older, 'Previous')}</span>
          </label>
        </div>
      )}
    </div>
  );
}

/** The two versions a comparison reads, and the format it reads them in. */
interface IComparisonInputs {
  target: IVersionTarget;
  older: IOutputVersion;
  newer: IOutputVersion;
  olderFormat: string;
  newerFormat: string;
}

/**
 * Load a comparison of two versions, again whenever the target, either
 * version or the format changes; a result that arrives after that is dropped.
 * The loader reads only the inputs it is handed, so the hook knows what to
 * watch.
 */
function useComparison<T>(
  inputs: IComparisonInputs,
  load: (inputs: IComparisonInputs, signal: AbortSignal) => Promise<T>
): { result?: T; error?: string } {
  const { settings, entrypoint, universe, outputId } = inputs.target;
  const { older, newer, olderFormat, newerFormat } = inputs;
  const key = JSON.stringify([
    entrypoint,
    universe,
    outputId,
    older.commit,
    newer.commit,
    olderFormat,
    newerFormat
  ]);
  const [state, setState] = useState<{
    key: string;
    settings: IVersionTarget['settings'];
    result?: T;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    load(
      {
        target: { settings, entrypoint, universe, outputId },
        older,
        newer,
        olderFormat,
        newerFormat
      },
      controller.signal
    ).then(
      result => {
        if (!controller.signal.aborted) setState({ key, settings, result });
      },
      reason => {
        if (!controller.signal.aborted)
          setState({
            key,
            settings,
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    return () => controller.abort();
    // Versions are read by commit, so the effect keys on the commits rather
    // than on the listing objects that name them.
  }, [
    settings,
    entrypoint,
    universe,
    outputId,
    older.commit,
    newer.commit,
    olderFormat,
    newerFormat,
    key
  ]);
  // Effects run after paint: a new pair must never render the prior pair's
  // values under its new captions, even before its request starts.
  return state?.key === key && state.settings === settings ? state : {};
}

function absentSide(version: IOutputVersion, ordinal: string): string {
  return `${ordinal[0].toUpperCase()}${ordinal.slice(1)} version (${version.short}): ${absentReason(version)}`;
}

function MetricCompare({
  target,
  newer,
  older
}: IVersionCompareProps): React.ReactElement {
  const { result, error } = useComparison<IMetricComparison>(
    { target, older, newer, olderFormat: 'json', newerFormat: 'json' },
    async (inputs, signal) => {
      const [before, after] = await Promise.all([
        readVersionJson(inputs.target, inputs.older.commit, signal),
        readVersionJson(inputs.target, inputs.newer.commit, signal)
      ]);
      return metricDeltas(before, after);
    }
  );
  if (!older.present)
    return <p role="status">{absentSide(older, 'previous')}</p>;
  if (!newer.present) return <p role="status">{absentSide(newer, 'shown')}</p>;
  if (error) return <p role="status">Comparison failed: {error}</p>;
  if (!result) return <p role="status">Comparing values…</p>;
  if (!result.deltas.length)
    return <p role="status">Neither version holds numeric values.</p>;
  return (
    <>
      {result.truncated && (
        <p role="status">
          Showing the first {METRIC_LEAF_LIMIT.toLocaleString()} values of each
          version.
        </p>
      )}
      <MetricDeltaTable result={result} newer={newer} older={older} />
    </>
  );
}

function MetricDeltaTable({
  result,
  newer,
  older
}: {
  result: IMetricComparison;
  newer: IOutputVersion;
  older: IOutputVersion;
}): React.ReactElement {
  return (
    <table className="jp-jupyterlab-lightcone-VersionCompare-deltas">
      <thead>
        <tr>
          <th scope="col">Value</th>
          <th scope="col">{versionCaption(older, 'Previous')}</th>
          <th scope="col">{versionCaption(newer, 'Shown')}</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {result.deltas.map(delta => (
          <tr key={delta.key} data-changed={delta.delta ? '' : undefined}>
            <th scope="row">
              <code>{delta.key}</code>
            </th>
            <td>{formatNumber(delta.older)}</td>
            <td>{formatNumber(delta.newer)}</td>
            <td>
              {delta.delta === undefined
                ? delta.older === undefined
                  ? 'added'
                  : 'removed'
                : delta.delta === 0
                  ? 'unchanged'
                  : `${delta.delta > 0 ? '+' : ''}${formatNumber(delta.delta)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableCompare({
  target,
  output,
  newer,
  older
}: IVersionCompareProps): React.ReactElement {
  const olderFormat = versionFormat(output, older);
  const newerFormat = versionFormat(output, newer);
  const { result, error } = useComparison<ITableShapeDiff>(
    { target, older, newer, olderFormat, newerFormat },
    async (inputs, signal) => {
      const [before, after] = await Promise.all([
        readVersionTableShape(
          inputs.target,
          inputs.older.commit,
          inputs.olderFormat,
          signal
        ),
        readVersionTableShape(
          inputs.target,
          inputs.newer.commit,
          inputs.newerFormat,
          signal
        )
      ]);
      return tableShapeDiff(before, after);
    }
  );
  if (!older.present)
    return <p role="status">{absentSide(older, 'previous')}</p>;
  if (!newer.present) return <p role="status">{absentSide(newer, 'shown')}</p>;
  if (error) return <p role="status">Comparison failed: {error}</p>;
  if (!result) return <p role="status">Comparing tables…</p>;
  const rows = (count: number, truncated: boolean) =>
    `${truncated ? 'at least ' : ''}${count.toLocaleString()} row${count === 1 ? '' : 's'}`;
  return (
    <div className="jp-jupyterlab-lightcone-VersionCompare-table">
      <dl>
        <div>
          <dt>{versionCaption(older, 'Previous')}</dt>
          <dd>
            {rows(result.older.rows, result.older.truncated)} ·{' '}
            {result.older.headers.length} columns
          </dd>
        </div>
        <div>
          <dt>{versionCaption(newer, 'Shown')}</dt>
          <dd>
            {rows(result.newer.rows, result.newer.truncated)} ·{' '}
            {result.newer.headers.length} columns
          </dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>
            {result.rowDelta === undefined
              ? 'Unknown (sampled tables)'
              : result.rowDelta === 0
                ? 'same count'
                : `${result.rowDelta > 0 ? '+' : ''}${result.rowDelta.toLocaleString()}`}
          </dd>
        </div>
        <div>
          <dt>Header</dt>
          <dd>
            {result.addedColumns.length || result.removedColumns.length ? (
              <>
                {result.addedColumns.length > 0 && (
                  <span>
                    added{' '}
                    {result.addedColumns.map(column => (
                      <code key={column}>{column}</code>
                    ))}
                  </span>
                )}
                {result.removedColumns.length > 0 && (
                  <span>
                    removed{' '}
                    {result.removedColumns.map(column => (
                      <code key={column}>{column}</code>
                    ))}
                  </span>
                )}
              </>
            ) : result.reordered ? (
              'same columns in another order'
            ) : (
              'unchanged'
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Compare the shown version of an output with the one made before it. */
export function VersionCompare(
  props: IVersionCompareProps
): React.ReactElement {
  const mode = comparisonModeFor(props.output, props.newer, props.older);
  let body: React.ReactNode;
  switch (mode) {
    case 'image':
      body = <ImageCompare {...props} />;
      break;
    case 'metric':
      body = <MetricCompare {...props} />;
      break;
    case 'table':
      body = <TableCompare {...props} />;
      break;
    default:
      body = (
        <p role="status">
          No comparison is available for these artifact versions.
        </p>
      );
  }
  return (
    <section
      className="jp-jupyterlab-lightcone-VersionCompare"
      aria-label="Version comparison"
    >
      <h4>
        Comparing <code>{props.newer.short}</code> with the previous version{' '}
        <code>{props.older.short}</code>
      </h4>
      {body}
    </section>
  );
}
