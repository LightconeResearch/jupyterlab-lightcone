import { normalizeDoi } from '@astra-spec/sdk';
import type { InventoryPaperMetadata } from '@astra-spec/ui/model';
import { ServerConnection } from '@jupyterlab/services';
import { apiUrl, requestAPI } from './request';

interface IPaperMetadata {
  doi: string;
  title?: string;
  authors?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** Status of an owner-scoped, managed MySTRA project. */
export interface IMySTRASession {
  id: string;
  path: string;
  state: 'starting' | 'ready' | 'failed';
  message: string;
  url: string;
  logs: string[];
}

/** Validate the server's viewer contract before assigning an iframe URL. */
function mySTRASession(value: unknown): IMySTRASession {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    typeof value.path !== 'string' ||
    (value.state !== 'starting' &&
      value.state !== 'ready' &&
      value.state !== 'failed') ||
    typeof value.message !== 'string' ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('/') ||
    value.url.startsWith('//') ||
    !value.url.endsWith(`/mystra/${value.id}/site/`) ||
    !Array.isArray(value.logs) ||
    !value.logs.every(item => typeof item === 'string')
  ) {
    throw new Error('The server returned an invalid MySTRA viewer session.');
  }
  return {
    id: value.id,
    path: value.path,
    state: value.state,
    message: value.message,
    url: value.url,
    logs: value.logs
  };
}

/** Format viewer service failures, keeping the HTTP status for callers. */
function mySTRAError(error: unknown): Error {
  return error instanceof RequestError
    ? error
    : new RequestError('MySTRA', error);
}

/** Start or reuse the CLI for the nearest local MyST project. */
export async function startMySTRA(
  settings: ServerConnection.ISettings,
  path: string
): Promise<IMySTRASession> {
  try {
    return mySTRASession(
      await requestAPI('mystra/sessions', settings, {
        method: 'POST',
        body: JSON.stringify({ path }),
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (error) {
    throw mySTRAError(error);
  }
}

/** Read status and renew the viewer's lease. */
export async function readMySTRA(
  settings: ServerConnection.ISettings,
  id: string
): Promise<IMySTRASession> {
  try {
    return mySTRASession(
      await requestAPI(`mystra/sessions/${encodeURIComponent(id)}`, settings)
    );
  } catch (error) {
    throw mySTRAError(error);
  }
}

/** Explicitly stop a project's process group; expired sessions are already stopped. */
export async function stopMySTRA(
  settings: ServerConnection.ISettings,
  id: string
): Promise<void> {
  try {
    await requestAPI(`mystra/sessions/${encodeURIComponent(id)}`, settings, {
      method: 'DELETE'
    });
  } catch (error) {
    throw mySTRAError(error);
  }
}
