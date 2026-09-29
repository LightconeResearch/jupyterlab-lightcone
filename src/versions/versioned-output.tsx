import React, { useEffect, useMemo, useState } from 'react';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { ArtifactPreview } from '@astra-spec/ui/components';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import { isVisualOutput, type OutputStatus } from '@astra-spec/ui/model';
import { Button } from '@astra-spec/ui/primitives';
import type { Contents } from '@jupyterlab/services';
import { RequestError } from '../api';
import { isRootAnalysisOutput } from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import { serverReadsProject } from '../server-features';
import { listVersionsCached, forgetVersions } from './version-cache';
import {
  comparisonModeFor,
  previewForVersion,
  type IVersionTarget
} from './version-content';
import { VersionCompare } from './version-compare';
import {
  stepVersion,
  versionPosition,
  type IVersionPosition
} from './version-model';
import { relativeTime } from '../relative-time';
import { VersionStepper } from './version-stepper';
import type { IOutputVersion } from './versions-api';

/** Version state of the output an element tab shows. */
export interface IOutputVersioning {
  /** Versions exist only for root-analysis outputs on the local drive. */
  enabled: boolean;
  target: IVersionTarget | undefined;
  /** Newest first. */
  versions: readonly IOutputVersion[];
  loading: boolean;
  error: string | undefined;
  /** The selected commit; undefined follows the newest version. */
  selected: string | undefined;
  select: (commit: string | undefined) => void;
  compare: boolean;
  setCompare: (open: boolean) => void;
  /** The version made before the shown one. */
  previous: IOutputVersion | undefined;
  /** The version shown: the selected one, else the newest. */
  shown: IOutputVersion | undefined;
  position: IVersionPosition | undefined;
  /** Whether the shown version is the newest committed one. */
  isLatest: boolean;
}

/**
 * Load the committed versions of an output and show the one selected. The
 * listing reloads when the artifact changes or its materialization status
 * moves, so a run that just finished appears without reopening the tab.
 *
 * The selection is controlled: `selected` comes from the host (a record tab
 * keeps it in its history entry) and every change goes through `onSelect`,
 * so a version requested while the output is already shown takes effect. A
 * selected commit outside the bounded history stays selected and unavailable;
 * only an explicit Latest action resumes the current artifact.
 */
export function useOutputVersioning(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  output: ResolvedOutput | undefined,
  status: OutputStatus | undefined,
  selected: string | undefined,
  onSelect: (commit: string | undefined) => void
): IOutputVersioning {
  const universe = data.document.universe.universeId;
  const enabled =
    !!output &&
    isRootAnalysisOutput(data.index, output) &&
    serverReadsProject(contents, entrypoint);
  const outputId = output?.id;
  const cacheToken =
    data.bindings.find(binding => binding.outputPath === output?.canonicalPath)
      ?.cacheToken ?? '';
  const settings = contents.serverSettings;
  const target = useMemo<IVersionTarget | undefined>(
    () =>
      enabled && outputId
        ? { settings, entrypoint, universe, outputId }
        : undefined,
    [enabled, settings, entrypoint, universe, outputId]
  );
  const [listing, setListing] = useState<{
    key: string;
    versions?: readonly IOutputVersion[];
    error?: string;
  }>({ key: '' });
  const [compare, setCompare] = useState(false);
  const state = status?.state;
  const detail = status?.detail;
  const key = JSON.stringify([
    entrypoint,
    universe,
    outputId,
    cacheToken,
    state,
    detail
  ]);
  useEffect(() => {
    if (!target) return;
    let active = true;
    // Anything that may mean a new run bypasses the shared listing cache.
    forgetVersions(settings, entrypoint, universe, target.outputId);
    listVersionsCached(settings, entrypoint, universe, target.outputId).then(
      result => {
        if (active) setListing({ key, versions: result.versions });
      },
      reason => {
        if (!active) return;
        // An output that was never materialized has no file to list: that is
        // an empty history, not a failure worth a message.
        if (reason instanceof RequestError && reason.status === 404) {
          setListing({ key, versions: [] });
          return;
        }
        setListing({
          key,
          error: reason instanceof Error ? reason.message : String(reason)
        });
      }
    );
    return () => {
      active = false;
    };
  }, [target, settings, entrypoint, universe, key]);
  const current = listing.key === key ? listing : undefined;
  const versions = current?.versions ?? [];
  const position = versionPosition(versions, selected);
  const shown = position ? versions[position.index] : undefined;
  const previousCommit = stepVersion(versions, selected, -1);
  const previous = previousCommit
    ? versions.find(version => version.commit === previousCommit)
    : undefined;
  const canCompare =
    !!output &&
    !!shown &&
    !!previous &&
    comparisonModeFor(output, shown, previous) !== 'none';
  useEffect(() => {
    if (!canCompare) setCompare(false);
  }, [canCompare]);
  return {
    enabled,
    target,
    versions,
    loading: enabled && !current,
    error:
      current?.error ??
      (current?.versions && selected && !position
        ? `Requested version ${selected} is outside the available history. Select Latest to view the current output.`
        : undefined),
    selected,
    select: commit => {
      onSelect(commit);
      if (commit === undefined) setCompare(false);
    },
    shown,
    position,
    previous,
    // Hide an invalid pair immediately, then clear the user's comparison
    // choice so stepping back to a valid pair does not silently reopen it.
    compare: compare && canCompare,
    setCompare,
    isLatest: !selected || position?.index === 0
  };
}

/**
 * The bounded preview of an output's bytes at one committed version, in the
 * same frame as the current artifact's preview.
 */
export function OlderVersionPreview({
  target,
  output,
  version,
  compact
}: {
  target: IVersionTarget;
  output: ResolvedOutput;
  version: IOutputVersion;
  compact: boolean;
}): React.ReactElement {
  const [preview, setPreview] = useState<ArtifactPreviewData>({
    kind: 'loading'
  });
  useEffect(() => {
    const controller = new AbortController();
    setPreview({ kind: 'loading' });
    previewForVersion(target, output, version, controller.signal).then(
      value => {
        if (!controller.signal.aborted) setPreview(value);
      },
      reason => {
        if (!controller.signal.aborted)
          setPreview({
            kind: 'unavailable',
            reason:
              reason instanceof Error
                ? reason.message
                : 'The version could not be loaded.'
          });
      }
    );
    return () => controller.abort();
  }, [target, output, version]);
  return (
    <ArtifactPreview
      output={output}
      preview={preview}
      compact={compact}
      caption={null}
    />
  );
}

function OlderVersionBanner({
  versioning
}: {
  versioning: IOutputVersioning;
}): React.ReactElement | null {
  const { shown, position } = versioning;
  if (!shown || !position || versioning.isLatest) return null;
  return (
    <p className="jp-jupyterlab-lightcone-VersionBanner" role="status">
      <span>
        Older version · v{position.ordinal} of {position.total} · made{' '}
        <time dateTime={shown.time} title={shown.time}>
          {relativeTime(shown.time)}
        </time>
      </span>
      <Button
        size="small"
        variant="secondary"
        onClick={() => versioning.select(undefined)}
      >
        Latest
      </Button>
    </p>
  );
}

function Stepper({
  versioning,
  output
}: {
  versioning: IOutputVersioning;
  output: ResolvedOutput;
}): React.ReactElement {
  return (
    <VersionStepper
      versions={versioning.versions}
      selected={versioning.selected}
      onSelect={versioning.select}
      canCompare={
        !!versioning.shown &&
        !!versioning.previous &&
        comparisonModeFor(output, versioning.shown, versioning.previous) !==
          'none'
      }
      compareOpen={versioning.compare}
      onCompareChange={versioning.setCompare}
      loading={versioning.loading}
      error={versioning.error}
    />
  );
}

/**
 * The artifact area of a versioned output: the current artifact, the selected
 * older version's bytes, or a comparison. A figure's frame zooms and pans
 * everything in it, so the stepper and the older-version banner live in the
 * `VersionBar` above the output instead. The compact form (cards and the
 * metric pill) only swaps in the older bytes.
 */
export function VersionedArtifact({
  versioning,
  output,
  compact,
  current
}: {
  versioning: IOutputVersioning;
  output: ResolvedOutput;
  compact: boolean;
  /** What the host renders for the current artifact. */
  current: React.ReactNode;
}): React.ReactElement {
  const { target, shown, previous } = versioning;
  if (!versioning.enabled || !target) return <>{current}</>;
  // Never substitute current bytes while an explicitly requested commit is
  // loading or missing from the bounded listing.
  if (versioning.selected && !shown) {
    return (
      <ArtifactPreview
        output={output}
        compact={compact}
        caption={null}
        preview={
          versioning.loading
            ? { kind: 'loading' }
            : {
                kind: 'unavailable',
                reason:
                  versioning.error ?? 'The requested version is unavailable.'
              }
        }
      />
    );
  }
  const older = shown && versioning.selected ? shown : undefined;
  if (
    !compact &&
    isVisualOutput(output) &&
    versioning.compare &&
    shown &&
    previous
  ) {
    return (
      <VersionCompare
        target={target}
        output={output}
        newer={shown}
        older={previous}
      />
    );
  }
  return older ? (
    <OlderVersionPreview
      target={target}
      output={output}
      version={older}
      compact={compact}
    />
  ) : (
    <>{current}</>
  );
}

/**
 * The version controls of a figure or a table, above its frame: the stepper,
 * and the banner saying an older version is shown.
 */
export function VersionBar({
  versioning,
  output
}: {
  versioning: IOutputVersioning;
  output: ResolvedOutput;
}): React.ReactElement | null {
  if (!versioning.enabled || !versioning.target || !isVisualOutput(output))
    return null;
  return (
    <div className="jp-jupyterlab-lightcone-VersionBar">
      <Stepper versioning={versioning} output={output} />
      <OlderVersionBanner versioning={versioning} />
    </div>
  );
}

/**
 * The version controls of an output without a picture to frame (a metric or
 * a data file), shown at the head of its provenance rail instead of below an
 * artifact.
 */
export function VersionRail({
  versioning,
  output
}: {
  versioning: IOutputVersioning;
  output: ResolvedOutput;
}): React.ReactElement | null {
  const { target, shown, previous } = versioning;
  if (!versioning.enabled || !target || isVisualOutput(output)) return null;
  return (
    <section className="jp-jupyterlab-lightcone-VersionRail">
      <h4>Versions</h4>
      <OlderVersionBanner versioning={versioning} />
      <Stepper versioning={versioning} output={output} />
      {versioning.compare && shown && previous && (
        <VersionCompare
          target={target}
          output={output}
          newer={shown}
          older={previous}
        />
      )}
    </section>
  );
}
