import type { OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import { isRecord, RequestError } from './api';
import { requestAPI } from './request';

/** `lc status` per output, keyed `<universe>/<output id>`. */
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
  try {
    const payload = await requestAPI(
      `api/materialization?${query}`,
      contents.serverSettings
    );
    return parseMaterializationStatuses(payload);
  } catch (error) {
    throw new RequestError('Materialization status', error);
  }
}
