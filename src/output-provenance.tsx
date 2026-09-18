import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import { OutputProvenance } from '@astra-spec/ui/components';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useState } from 'react';
import { isRecord, RequestError } from './api';
import { isRootAnalysisOutput } from './materialization-status';
import { requestAPI } from './request';

/** Keep the UI contract independent of Lightcone's on-disk field names. */
export function parseRunRecord(payload: unknown): OutputRun | null {
  const invalid = () => new Error('Unsupported run record.');
  if (!isRecord(payload)) throw invalid();
  if (payload.record === null) return null;
  const record = payload.record;
  if (!isRecord(record) || record.schema_version !== 1) throw invalid();
  const string = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') throw invalid();
    return value;
  };
  const versions = (key: string): Record<string, string> => {
    const value = record[key];
    if (
      !isRecord(value) ||
      Object.values(value).some(item => typeof item !== 'string')
    )
      throw invalid();
    return value as Record<string, string>;
  };
  return {
    finishedAt: string('finished_at'),
    gitRevision: string('git_sha'),
    recipe: string('recipe'),
    environment: string('env_version'),
    cliVersion: string('lc_version'),
    inputVersions: versions('input_versions')
  };
}

/** Requests in flight, so the provenance panel and code link share one read. */
const pendingRecords = new Map<string, Promise<OutputRun | null>>();

/**
 * Read one output's run record for the selected universe; `null` when none
 * was recorded. Lightcone records runs only for local root-analysis outputs.
 */
export function fetchRunRecord(
  contents: Contents.IManager,
  entrypoint: string,
  index: AnalysisIndex,
  universe: string,
  output: ResolvedOutput
): Promise<OutputRun | null> {
  if (!isRootAnalysisOutput(index, output) || contents.driveName(entrypoint))
    return Promise.reject(
      new Error('Run records require an output in a local root analysis.')
    );
  const query = new URLSearchParams({
    path: entrypoint,
    universe,
    output: output.id
  }).toString();
  let pending = pendingRecords.get(query);
  if (!pending) {
    pending = requestAPI(`api/provenance?${query}`, contents.serverSettings)
      .then(parseRunRecord)
      .finally(() => pendingRecords.delete(query));
    pendingRecords.set(query, pending);
  }
  return pending;
}

/** Mounted only for the open output detail; never reads every output's record. */
export function JupyterOutputProvenance({
  contents,
  entrypoint,
  index,
  universe,
  output,
  status
}: {
  contents: Contents.IManager;
  entrypoint: string;
  index: AnalysisIndex;
  universe: string;
  output: ResolvedOutput;
  status: OutputStatus | undefined;
}): React.ReactElement {
  const [result, setResult] = useState<{
    record?: OutputRun | null;
    error?: string;
  }>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    let active = true;
    setResult(undefined);
    fetchRunRecord(contents, entrypoint, index, universe, output).then(
      record => {
        if (active) setResult({ record });
      },
      reason => {
        if (active)
          setResult({ error: new RequestError('Provenance', reason).message });
      }
    );
    // Ignoring a superseded response is what keeps it from landing.
    // A refreshed output can represent a new run even when its status is unchanged.
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, universe, output, state, detail]);
  return (
    <OutputProvenance
      status={status}
      run={result?.record}
      error={result?.error}
    />
  );
}
