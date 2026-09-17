import type { ResolvedOutput } from '@astra-spec/sdk';
import { OutputProvenance } from '@astra-spec/ui/components';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useState } from 'react';
import { isRecord, RequestError } from './api';
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

/** Mounted only for the open output detail; never reads every output's record. */
export function JupyterOutputProvenance({
  contents,
  entrypoint,
  universe,
  output,
  status,
  supported
}: {
  contents: Contents.IManager;
  entrypoint: string;
  universe: string;
  output: ResolvedOutput;
  status: OutputStatus | undefined;
  supported: boolean;
}): React.ReactElement {
  const query = new URLSearchParams({
    path: entrypoint,
    universe,
    output: output.id
  }).toString();
  const [result, setResult] = useState<{
    record?: OutputRun | null;
    error?: string;
  }>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    const load = async () => {
      try {
        if (!supported || contents.driveName(entrypoint))
          throw new Error(
            'Run records require an output in a local root analysis.'
          );
        const payload = await requestAPI(
          `api/provenance?${query}`,
          contents.serverSettings,
          { signal: controller.signal }
        );
        const record = parseRunRecord(payload);
        if (!controller.signal.aborted) setResult({ record });
      } catch (reason) {
        if (!controller.signal.aborted)
          setResult({ error: new RequestError('Provenance', reason).message });
      }
    };
    void load();
    // Aborting on re-run is what keeps a superseded response from landing;
    // `query` already carries the entrypoint, universe and output identity.
    // A refreshed output can represent a new run even when its status is unchanged.
    return () => controller.abort();
  }, [contents, entrypoint, query, supported, output, state, detail]);
  return (
    <OutputProvenance
      status={status}
      run={result?.record}
      error={result?.error}
    />
  );
}
