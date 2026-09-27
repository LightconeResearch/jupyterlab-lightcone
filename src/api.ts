import { normalizeDoi, type ResolvedOutput } from '@astra-spec/sdk';
import type {
  InventoryPaperMetadata,
  OutputRun,
  OutputStatus
} from '@astra-spec/ui/model';
import { ServerConnection } from '@jupyterlab/services';
import { apiUrl, requestAPI } from './request';

export interface IProjectFolder {
  path: string;
  directory: string;
  hasSpec: boolean;
}

/** Inspect a selected directory without changing it. */
export function inspectProjectFolder(
  settings: ServerConnection.ISettings,
  path: string
): Promise<IProjectFolder> {
  return requestProjectFolder(
    settings,
    `api/projects?${new URLSearchParams({ path: path || '.' })}`
  );
}

/** Explicitly create or finish setting up the selected directory. */
export function initializeProjectFolder(
  settings: ServerConnection.ISettings,
  path: string
): Promise<IProjectFolder> {
  return requestProjectFolder(settings, 'api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path || '.' })
  });
}

async function requestProjectFolder(
  settings: ServerConnection.ISettings,
  endpoint: string,
  init: RequestInit = {}
): Promise<IProjectFolder> {
  try {
    const data = await requestAPI(endpoint, settings, init);
    if (
      !isRecord(data) ||
      typeof data.path !== 'string' ||
      typeof data.directory !== 'string' ||
      typeof data.hasSpec !== 'boolean'
    ) {
      throw new Error('The server returned an invalid project folder.');
    }
    return {
      path: data.path,
      directory: data.directory,
      hasSpec: data.hasSpec
    };
  } catch (error) {
    throw new RequestError('Project setup', error);
  }
}

/** Recognize project directories in one shallow, read-only listing. */
export async function projectFolders(
  settings: ServerConnection.ISettings,
  path: string
): Promise<string[]> {
  try {
    const data = await requestAPI(
      `api/projects?${new URLSearchParams({ path: path || '.', children: 'true' })}`,
      settings
    );
    if (
      !isRecord(data) ||
      !Array.isArray(data.projects) ||
      !data.projects.every((path): path is string => typeof path === 'string')
    ) {
      throw new Error('The server returned an invalid project listing.');
    }
    return data.projects;
  } catch (error) {
    throw new RequestError('Project browser', error);
  }
}

/**
 * Tell the server which project the workbench is in, or null outside every
 * project. Chats stored outside a project join it when they are first used.
 */
export async function reportCurrentProject(
  settings: ServerConnection.ISettings,
  entrypoint: string | null
): Promise<void> {
  try {
    const data = await requestAPI('api/current-project', settings, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entrypoint })
    });
    if (!isRecord(data) || !('entrypoint' in data)) {
      throw new Error('The server returned an invalid current project.');
    }
  } catch (error) {
    throw new RequestError('Current project', error);
  }
}

interface IPaperMetadata {
  doi: string;
  title?: string;
  authors?: string;
}

/** Narrow an untrusted server payload to a plain object before reading fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaperMetadata(value: unknown): value is IPaperMetadata {
  return (
    isRecord(value) &&
    typeof value.doi === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.authors === undefined || typeof value.authors === 'string')
  );
}

/** A server failure with its HTTP status, without an HTML error page in the UI. */
export class RequestError extends Error {
  readonly status: number | undefined;

  constructor(subject: string, error: unknown) {
    if (error instanceof ServerConnection.ResponseError) {
      const detail = /<!doctype|<html/i.test(error.message)
        ? 'The server returned an HTML error page.'
        : error.message;
      super(`${subject} request failed (${error.response.status}): ${detail}`);
      this.status = error.response.status;
    } else {
      super(
        `${subject} request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.status = undefined;
    }
    this.name = 'RequestError';
  }
}

/** Format paper service failures for dialogs. */
function paperError(error: unknown): Error {
  return error instanceof RequestError
    ? error
    : new RequestError('Paper', error);
}

/** Cached PDFs are served by the authenticated Jupyter server. */
export function paperPdfUrl(
  settings: ServerConnection.ISettings,
  doi: string
): string {
  return `${apiUrl('api/papers/pdf', settings)}?${new URLSearchParams({ doi: normalizeDoi(doi) })}`;
}

function paperMetadata(
  settings: ServerConnection.ISettings,
  paper: IPaperMetadata
): InventoryPaperMetadata {
  return {
    title: paper.title,
    authors: paper.authors,
    pdfUrl: paperPdfUrl(settings, paper.doi)
  };
}

/** Look up cached papers without initiating downloads. */
export async function collectPaperMetadata(
  settings: ServerConnection.ISettings,
  citedDois: readonly string[]
): Promise<Record<string, InventoryPaperMetadata>> {
  const dois = [...new Set(citedDois.map(normalizeDoi))];
  const papers: Record<string, InventoryPaperMetadata> = {};
  try {
    // Bound each query URL for projects with many references.
    for (let start = 0; start < dois.length; start += 40) {
      const query = new URLSearchParams();
      for (const doi of dois.slice(start, start + 40)) {
        query.append('doi', doi);
      }
      const payload = await requestAPI(`api/papers?${query}`, settings);
      if (!isRecord(payload) || !isRecord(payload.papers)) {
        throw new Error('The server returned invalid paper metadata.');
      }
      for (const [doi, value] of Object.entries(payload.papers)) {
        if (!isPaperMetadata(value) || normalizeDoi(value.doi) !== doi) {
          throw new Error('The server returned invalid paper metadata.');
        }
        papers[doi] = paperMetadata(settings, value);
      }
    }
    return papers;
  } catch (error) {
    throw paperError(error);
  }
}

/** Fetch a paper only after the user requests it. */
export async function fetchPaper(
  doi: string,
  settings: ServerConnection.ISettings
): Promise<InventoryPaperMetadata> {
  const normalized = normalizeDoi(doi);
  try {
    const payload = await requestAPI('api/papers/fetch', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doi: normalized })
    });
    if (
      !isRecord(payload) ||
      !isPaperMetadata(payload.paper) ||
      normalizeDoi(payload.paper.doi) !== normalized
    ) {
      throw new Error('The server returned invalid paper metadata.');
    }
    return paperMetadata(settings, payload.paper);
  } catch (error) {
    throw paperError(error);
  }
}

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

/**
 * Reads in flight, so the provenance panel and code link share one. Keying by
 * the output snapshot and its status keeps a read issued before a refresh or
 * a status change from answering for the run that followed it.
 */
const pendingRunRecords = new WeakMap<
  ResolvedOutput,
  Map<string, Promise<OutputRun | null>>
>();

/**
 * Read one output's run record for the selected universe; `null` when none
 * was recorded. Lightcone records runs only for local root-analysis outputs,
 * so callers keep other outputs out.
 */
export function fetchRunRecord(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: ResolvedOutput,
  status?: OutputStatus
): Promise<OutputRun | null> {
  let pending = pendingRunRecords.get(output);
  if (!pending) {
    pending = new Map();
    pendingRunRecords.set(output, pending);
  }
  const reads = pending;
  const key = JSON.stringify([
    entrypoint,
    universe,
    status?.state,
    status?.detail
  ]);
  let read = reads.get(key);
  if (!read) {
    const query = new URLSearchParams({
      path: entrypoint,
      universe,
      output: output.id
    });
    read = requestAPI(`api/provenance?${query}`, settings)
      .then(parseRunRecord)
      .catch(error => {
        throw error instanceof RequestError
          ? error
          : new RequestError('Provenance', error);
      })
      .finally(() => reads.delete(key));
    reads.set(key, read);
  }
  return read;
}
