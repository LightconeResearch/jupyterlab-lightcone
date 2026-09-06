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

/** Format server failures without placing a full HTML error page in the UI. */
function paperError(error: unknown): Error {
  if (error instanceof ServerConnection.ResponseError) {
    const detail = /<!doctype|<html/i.test(error.message)
      ? 'The server returned an HTML error page.'
      : error.message;
    return new Error(
      `Paper request failed (${error.response.status}): ${detail}`
    );
  }
  return new Error(
    `Paper request failed: ${error instanceof Error ? error.message : String(error)}`
  );
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
