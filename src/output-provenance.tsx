import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import { OutputProvenance } from '@astra-spec/ui/components';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useState } from 'react';
import type { IOutputVersion } from './versions/versions-api';
import { fetchRunRecord, parseRunRecord } from './api';
import { isRootAnalysisOutput } from './materialization-status';

/** Mounted only for the open output detail; never reads every output's record. */
export function JupyterOutputProvenance({
  contents,
  entrypoint,
  index,
  universe,
  output,
  status,
  version
}: {
  contents: Contents.IManager;
  entrypoint: string;
  index: AnalysisIndex;
  universe: string;
  output: ResolvedOutput;
  status: OutputStatus | undefined;
  /** The selected commit supplies its own manifest, never today's sidecar. */
  version?: IOutputVersion;
}): React.ReactElement {
  const [result, setResult] = useState<{
    record?: OutputRun | null;
    error?: string;
  }>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    let active = true;
    if (
      !isRootAnalysisOutput(index, output) ||
      contents.driveName(entrypoint)
    ) {
      setResult({
        error: 'Run records require an output in a local root analysis.'
      });
      return;
    }
    setResult(undefined);
    // A refreshed output can represent a new run even when its status is
    // unchanged, and a changed status always can, so both start a fresh read.
    fetchRunRecord(
      contents.serverSettings,
      entrypoint,
      universe,
      output,
      state ? { state, detail } : undefined
    ).then(
      record => {
        if (active) setResult({ record });
      },
      reason => {
        if (active)
          setResult({
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    // Ignoring a superseded response is what keeps it from landing.
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, universe, output, state, detail]);
  return (
    <OutputProvenance
      status={status}
      run={
        version ? parseRunRecord({ record: version.manifest }) : result?.record
      }
      error={version ? undefined : result?.error}
    />
  );
}
