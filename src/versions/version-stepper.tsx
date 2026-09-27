import React from 'react';
import { Chevron } from './chevron';
import { Button } from '@astra-spec/ui/primitives';
import type { IOutputVersion } from './versions-api';
import { formatBytes, stepVersion, versionPosition } from './version-model';
import { relativeTime } from '../relative-time';

export interface IVersionStepperProps {
  /** Newest first. */
  versions: readonly IOutputVersion[];
  /** The commit shown; undefined means the newest. */
  selected: string | undefined;
  /** Select a commit; undefined returns to the newest. */
  onSelect: (commit: string | undefined) => void;
  /** Whether a comparison of the shown version with the previous one is possible. */
  canCompare: boolean;
  compareOpen: boolean;
  onCompareChange: (open: boolean) => void;
  loading: boolean;
  error: string | undefined;
}

/**
 * History covers committed outputs in the engine’s results directory.
 */
export const VERSION_LIMITS =
  'Versions are Git commits that changed this materialized output. Older bytes stay available while git-annex keeps their content in this repository, and a version held elsewhere names the repository that has it. Uncommitted files and scratch files outside the results directory have no output history.';

/** "v3 of 3 · 2 days ago · a889877" with older/newer controls. */
export function VersionStepper({
  versions,
  selected,
  onSelect,
  canCompare,
  compareOpen,
  onCompareChange,
  loading,
  error
}: IVersionStepperProps): React.ReactElement {
  const position = versionPosition(versions, selected);
  const version = position ? versions[position.index] : undefined;
  const older = stepVersion(versions, selected, -1);
  const newer = stepVersion(versions, selected, +1);
  let summary: React.ReactNode;
  if (version && position) {
    summary = (
      <>
        <strong>
          v{position.ordinal} of {position.total}
        </strong>
        <span aria-hidden="true"> · </span>
        <time dateTime={version.time} title={version.time}>
          {relativeTime(version.time)}
        </time>
        <span aria-hidden="true"> · </span>
        <code title={version.commit}>{version.short}</code>
        {version.size !== null && (
          <>
            <span aria-hidden="true"> · </span>
            <span>{formatBytes(version.size)}</span>
          </>
        )}
      </>
    );
  } else if (loading) {
    summary = <span>Loading versions…</span>;
  } else if (error) {
    summary = <span>Version history unavailable: {error}</span>;
  } else {
    summary = <span>No committed versions of this output</span>;
  }
  return (
    <div
      className="jp-jupyterlab-lightcone-VersionStepper"
      role="group"
      aria-label="Output versions"
    >
      {selected && (!position || position.index === 0) && !loading && (
        <Button
          size="small"
          variant="secondary"
          onClick={() => onSelect(undefined)}
        >
          Latest
        </Button>
      )}
      <Button
        size="small"
        variant="quiet"
        aria-label="Older version"
        title="Older version"
        disabled={older === undefined}
        onClick={() => onSelect(older)}
      >
        <Chevron direction="back" />
      </Button>
      <span className="jp-jupyterlab-lightcone-VersionStepper-summary">
        {summary}
      </span>
      <span
        className="jp-jupyterlab-lightcone-VersionStepper-limits"
        title={VERSION_LIMITS}
        aria-label={VERSION_LIMITS}
        role="note"
      >
        ⓘ
      </span>
      <Button
        size="small"
        variant="quiet"
        aria-label="Newer version"
        title="Newer version"
        disabled={newer === undefined}
        onClick={() => {
          // Reaching the newest version clears the selection, so a new
          // materialization is followed again.
          onSelect(newer === versions[0]?.commit ? undefined : newer);
        }}
      >
        <Chevron direction="forward" />
      </Button>
      {version && older !== undefined && (
        <Button
          size="small"
          variant={compareOpen ? 'secondary' : 'quiet'}
          aria-pressed={compareOpen}
          disabled={!canCompare}
          title={
            canCompare
              ? 'Compare this version with the previous one'
              : 'No comparison is available for this artifact format'
          }
          onClick={() => onCompareChange(!compareOpen)}
        >
          {compareOpen ? 'Close comparison' : 'Compare with previous'}
        </Button>
      )}
    </div>
  );
}
