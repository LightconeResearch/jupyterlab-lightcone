import {
  normalizeDoi,
  walkAnalyses,
  type ResolvedAnalysisDocument
} from '@astra-spec/sdk';
import type { InventoryPaperMetadata } from '@astra-spec/ui/model';

/**
 * Cited papers the browser can read without the paper cache.
 *
 * A DOI resolves to an HTML landing page, so no generic rule turns one into a
 * PDF. arXiv is the exception: its DOIs embed the arXiv identifier, and
 * `arxiv.org/pdf/<id>` serves the PDF with a permissive CORS policy and byte
 * ranges, which is what the paper viewer needs to stream it from the browser.
 * Every other DOI keeps the viewer's own "no paper content" state, which links
 * to the DOI. The same rule as `@astra-spec/theme-astra`'s `papers.ts`, so a
 * paper reads the same in Lab as on the published site.
 */

const ARXIV_DOI_PREFIX = '10.48550/arxiv.';

/** New-style `YYMM.NNNNN` identifiers. */
const NEW_STYLE_ID = /^\d{4}\.\d{4,5}$/;

/**
 * Old-style `archive[.subject-class]/YYMMNNN` identifiers, such as
 * `astro-ph/0604362` or `cond-mat.mes-hall/0507011`.
 */
const OLD_STYLE_ID = /^[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/\d{7}$/;

/** The arXiv identifier a DOI names, or undefined for any other DOI. */
export function arxivIdFromDoi(doi: string): string | undefined {
  const key = normalizeDoi(doi);
  if (!key.startsWith(ARXIV_DOI_PREFIX)) return undefined;
  const id = key.slice(ARXIV_DOI_PREFIX.length);
  return NEW_STYLE_ID.test(id) || OLD_STYLE_ID.test(id) ? id : undefined;
}

/** A cited arXiv revision: a positive integer; anything else means "latest". */
function citedVersion(version: unknown): number | undefined {
  return typeof version === 'number' && Number.isInteger(version) && version > 0
    ? version
    : undefined;
}

/**
 * The PDF of an arXiv DOI. A positive integer version pins that revision
 * (`…v2`); without one arXiv serves its latest.
 */
export function arxivPdfUrl(doi: string, version?: number): string | undefined {
  const id = arxivIdFromDoi(doi);
  const revision = citedVersion(version);
  return id
    ? `https://arxiv.org/pdf/${id}${revision === undefined ? '' : `v${revision}`}`
    : undefined;
}

/**
 * A `pdfUrl` for every cited arXiv paper, keyed by normalized DOI; other DOIs
 * are left out. When insights cite different revisions of one paper the
 * newest wins: the viewer reads one file per DOI, and the latest revision is
 * the one most likely to hold every quoted passage. A citation naming no
 * revision reads the latest, so it wins over every pinned one. The walk
 * repeats the SDK's `collectCitedDois`, which yields DOIs only, for the
 * `version`s.
 */
export function arxivPaperMetadata(
  document: ResolvedAnalysisDocument
): Record<string, InventoryPaperMetadata> {
  const versions = new Map<string, number | 'latest'>();
  for (const analysis of walkAnalyses(document)) {
    for (const insight of [...analysis.prior_insights, ...analysis.findings]) {
      for (const evidence of insight.evidence) {
        if (typeof evidence.doi !== 'string') continue;
        const key = normalizeDoi(evidence.doi);
        if (!arxivIdFromDoi(key)) continue;
        const cited = citedVersion(evidence.version) ?? 'latest';
        const newest = versions.get(key) ?? cited;
        versions.set(
          key,
          cited === 'latest' || newest === 'latest'
            ? 'latest'
            : Math.max(cited, newest)
        );
      }
    }
  }
  const papers: Record<string, InventoryPaperMetadata> = {};
  for (const [doi, version] of versions) {
    const pdfUrl = arxivPdfUrl(doi, version === 'latest' ? undefined : version);
    if (pdfUrl) papers[doi] = { pdfUrl };
  }
  return papers;
}
