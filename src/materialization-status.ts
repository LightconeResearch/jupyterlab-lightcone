import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import { Poll } from '@lumino/polling';
import { useEffect, useState } from 'react';
import { isRecord, RequestError } from './api';
import { requestAPI } from './request';
import { projectDirectory, type ILoadedProjectData } from './project-data';

export type MaterializationStatuses = Record<string, OutputStatus>;

/** `lc status` states, passed through unchanged by the server and the UI. */
const STATES: ReadonlySet<OutputStatus['state']> = new Set([
  'current',
  'behind',
  'stale'
]);

function isStatusState(value: string): value is OutputStatus['state'] {
  return (STATES as ReadonlySet<string>).has(value);
}

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
      !isStatusState(value.state) ||
      typeof value.detail !== 'string'
    ) {
      throw invalid();
    }
    result[key] = { state: value.state, detail: value.detail };
  }
  return result;
}

/** The CLI reports status, and Lightcone records runs, only for the root analysis. */
export function isRootAnalysisOutput(
  index: AnalysisIndex,
  output: ResolvedOutput
): boolean {
  return (
    index.analysisByRecordPath.get(output.canonicalPath)?.canonicalPath === '$'
  );
}

/** Match CLI output IDs only in their owning root analysis and selected universe. */
export function outputMaterializationStatus(
  statuses: MaterializationStatuses | undefined,
  data: ILoadedProjectData,
  output: ResolvedOutput
): OutputStatus | undefined {
  if (!isRootAnalysisOutput(data.index, output)) {
    return undefined;
  }
  return statuses?.[`${data.document.universe.universeId}/${output.id}`];
}

/**
 * Ask the server for `lc status` of a project. Only local projects have one:
 * the command runs in the project's folder on the server.
 */
export async function fetchMaterializationStatuses(
  contents: Contents.IManager,
  entrypoint: string
): Promise<MaterializationStatuses> {
  if (contents.driveName(entrypoint)) {
    throw new Error('Materialization status requires local files.');
  }
  const query = new URLSearchParams({ path: entrypoint });
  const payload = await requestAPI(
    `api/materialization?${query}`,
    contents.serverSettings
  );
  return parseMaterializationStatuses(payload);
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
          publish({
            statuses: await fetchMaterializationStatuses(contents, entrypoint)
          });
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
