import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/lib';
import type { Contents } from '@jupyterlab/services';
import { Poll } from '@lumino/polling';
import { useEffect, useState } from 'react';
import { isRecord, RequestError } from './api';
import { requestAPI } from './request';
import { projectDirectory, type ILoadedProjectData } from './project-data';

export type MaterializationStatuses = Record<string, OutputStatus>;

const STATES: ReadonlySet<string> = new Set([
  'materialized',
  'outdated',
  'unmaterialized'
]);

/** Validate the optional server response before showing any success indicators. */
export function parseMaterializationStatuses(
  payload: unknown
): MaterializationStatuses {
  const invalid = () => new Error('Invalid materialization status report.');
  if (!isRecord(payload) || !isRecord(payload.outputs)) {
    throw invalid();
  }
  const result: MaterializationStatuses = Object.create(null);
  for (const [key, value] of Object.entries(payload.outputs)) {
    if (
      !isRecord(value) ||
      typeof value.state !== 'string' ||
      !STATES.has(value.state) ||
      typeof value.detail !== 'string'
    ) {
      throw invalid();
    }
    result[key] = {
      state: value.state as OutputStatus['state'],
      detail: value.detail
    };
  }
  return result;
}

/** Match CLI output IDs only in their owning root analysis and selected universe. */
export function outputMaterializationStatus(
  statuses: MaterializationStatuses | undefined,
  data: ILoadedProjectData,
  output: ResolvedOutput
): OutputStatus | undefined {
  if (
    data.index.analysisByRecordPath.get(output.canonicalPath)?.canonicalPath !==
    '$'
  ) {
    return undefined;
  }
  return statuses?.[`${data.document.universe.universeId}/${output.id}`];
}

/** Poll only while the inventory is mounted and visible; failures clear old checks. */
export function useMaterializationStatus(
  contents: Contents.IManager,
  entrypoint: string,
  document: ILoadedProjectData['document']
): { statuses?: MaterializationStatuses; error?: string } {
  const [result, setResult] = useState<{
    contents: Contents.IManager;
    document: ILoadedProjectData['document'];
    entrypoint: string;
    statuses?: MaterializationStatuses;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    const root = projectDirectory(entrypoint);
    const publish = (value: {
      statuses?: MaterializationStatuses;
      error?: string;
    }) => {
      if (active) {
        setResult({ contents, document, entrypoint, ...value });
      }
    };
    const poll = new Poll({
      name: `lightcone:materialization:${entrypoint}`,
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: 'when-hidden',
      factory: async () => {
        try {
          if (contents.driveName(entrypoint)) {
            throw new Error('Materialization status requires local files.');
          }
          const query = new URLSearchParams({ path: entrypoint });
          const payload = await requestAPI(
            `api/materialization?${query}`,
            contents.serverSettings
          );
          publish({ statuses: parseMaterializationStatuses(payload) });
        } catch (error) {
          publish({
            error: new RequestError('Materialization status', error).message
          });
          throw error;
        }
      }
    });
    const changed = (
      _sender: Contents.IManager,
      change: Contents.IChangedArgs
    ) => {
      if (
        [change.oldValue?.path, change.newValue?.path].some(
          path =>
            path !== undefined &&
            (!root || path === root || path.startsWith(`${root}/`))
        )
      ) {
        void poll.refresh();
      }
    };
    contents.fileChanged.connect(changed);
    return () => {
      active = false;
      contents.fileChanged.disconnect(changed);
      poll.dispose();
    };
  }, [contents, entrypoint, document]);
  return result?.contents === contents &&
    result.document === document &&
    result.entrypoint === entrypoint
    ? result
    : {};
}
