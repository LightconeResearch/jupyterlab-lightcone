import React, { useEffect, useId, useState } from 'react';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { Button } from '@astra-spec/ui/primitives';
import { versionContentUrl, type IOutputVersion } from './versions-api';
import {
  compareModeFor,
  readVersionJson,
  readVersionTableShape,
  type IVersionTarget
} from './version-content';
import {
  formatNumber,
  METRIC_LEAF_LIMIT,
  metricDeltas,
  outputFormat,
  relativeTime,
  tableShapeDiff,
  type IMetricComparison,
  type ITableShapeDiff
} from './version-model';

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
        <p role="status">Content not available locally</p>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function ImageCompare({
  target,
  output,
  newer,
  older
}: IVersionCompareProps): React.ReactElement {
  const [mode, setMode] = useState<'side' | 'swipe'>('side');
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
      </div>
      {mode === 'side' || !swipeable ? (
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

function useComparison<T>(
  load: (signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[]
): { result?: T; error?: string } {
  const [state, setState] = useState<{ result?: T; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    load(controller.signal).then(
      result => {
        if (!controller.signal.aborted) setState({ result });
      },
      reason => {
        if (!controller.signal.aborted)
          setState({
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    return () => controller.abort();
    // The caller lists what its loader reads.
  }, dependencies);
  return state;
}

function absentSide(version: IOutputVersion, ordinal: string): string {
  return `The ${ordinal} version (${version.short}) is not available locally.`;
}

function MetricCompare({
  target,
  newer,
  older
}: IVersionCompareProps): React.ReactElement {
  const { result, error } = useComparison<IMetricComparison>(
    async signal => {
      const [before, after] = await Promise.all([
        readVersionJson(target, older.commit, signal),
        readVersionJson(target, newer.commit, signal)
      ]);
      return metricDeltas(before, after);
    },
    [
      target.settings,
      target.entrypoint,
      target.universe,
      target.outputId,
      older.commit,
      newer.commit
    ]
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
  const format = outputFormat(output);
  const { result, error } = useComparison<ITableShapeDiff>(
    async signal => {
      const [before, after] = await Promise.all([
        readVersionTableShape(target, older.commit, format, signal),
        readVersionTableShape(target, newer.commit, format, signal)
      ]);
      return tableShapeDiff(before, after);
    },
    [
      target.settings,
      target.entrypoint,
      target.universe,
      target.outputId,
      older.commit,
      newer.commit,
      format
    ]
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
            {result.rowDelta === 0
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
  const mode = compareModeFor(props.output);
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
          No comparison is available for .{outputFormat(props.output) || '?'}{' '}
          artifacts.
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
