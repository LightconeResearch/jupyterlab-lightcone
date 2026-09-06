import {
  normalizeDoi,
  type AnalysisIndex,
  type ResolvedRecord
} from '@astra-spec/sdk';
import {
  paperEntry,
  recordEntry,
  type DetailEntry
} from '@astra-spec/ui/components';

export type InventoryRecordKind = ResolvedRecord['kind'];

export interface IInventoryRecordOpenReference {
  kind: InventoryRecordKind;
  id: string;
  canonicalPath?: string;
}

export interface IInventoryPaperOpenReference {
  kind: 'paper';
  doi: string;
}

/** The stable postMessage/command shape emitted by ASTRA publications. */
export type InventoryOpenReference =
  IInventoryRecordOpenReference | IInventoryPaperOpenReference;

const RECORD_KINDS: readonly string[] = [
  'input',
  'output',
  'decision',
  'finding',
  'prior_insight'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecordKind(value: string): value is InventoryRecordKind {
  return RECORD_KINDS.includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Validate untrusted command arguments or cross-frame messages. */
export function parseInventoryOpenReference(
  value: unknown
): InventoryOpenReference | undefined {
  if (!isRecord(value)) return undefined;
  const candidate: Record<string, unknown> = value;
  if (candidate.kind === 'paper') {
    const doi = nonEmptyString(candidate.doi);
    return doi ? { kind: 'paper', doi } : undefined;
  }
  if (typeof candidate.kind !== 'string' || !isRecordKind(candidate.kind)) {
    return undefined;
  }
  const id = nonEmptyString(candidate.id);
  if (!id) return undefined;
  const canonicalPath = nonEmptyString(candidate.canonicalPath);
  return {
    kind: candidate.kind,
    id,
    ...(canonicalPath ? { canonicalPath } : {})
  };
}

/** Resolve the publication wire format against the resolved-analysis index. */
export function detailEntryForOpenReference(
  index: AnalysisIndex,
  reference: InventoryOpenReference,
  requestedAnalysisPath = '$'
): DetailEntry | undefined {
  const analysisPath = index.analysisByPath.has(requestedAnalysisPath)
    ? requestedAnalysisPath
    : '$';
  if (reference.kind === 'paper') {
    const doi = normalizeDoi(reference.doi);
    const cited = [...index.recordByPath.values()].some(
      record =>
        (record.kind === 'finding' || record.kind === 'prior_insight') &&
        record.evidence.some(
          evidence => normalizeDoi(evidence.doi ?? '') === doi
        )
    );
    return cited ? paperEntry(doi, analysisPath) : undefined;
  }

  const exact = reference.canonicalPath
    ? index.recordByPath.get(reference.canonicalPath)
    : undefined;
  const matchingExact = exact?.kind === reference.kind ? exact : undefined;
  if (reference.canonicalPath && !matchingExact) {
    return undefined;
  }
  const candidates = matchingExact
    ? [matchingExact]
    : [...index.recordByPath.values()].filter(
        record => record.kind === reference.kind && record.id === reference.id
      );
  const record =
    candidates.find(
      candidate =>
        index.analysisByRecordPath.get(candidate.canonicalPath)
          ?.canonicalPath === analysisPath
    ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!record) return undefined;
  const owner = index.analysisByRecordPath.get(record.canonicalPath);
  return recordEntry(
    record.canonicalPath,
    owner?.canonicalPath ?? analysisPath
  );
}

/** Validate the publication's message payload before resolving an ASTRA record. */
export function publicationReference(data: unknown) {
  if (
    data === null ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== 'astra:open-reference' ||
    !('reference' in data)
  ) {
    return undefined;
  }
  return parseInventoryOpenReference(data.reference);
}

/** Only web publications may be embedded; relative URLs use the Jupyter origin. */
export function publicationUrl(value: string, baseUrl: string): URL {
  const url = new URL(value, baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'The publication URL must use HTTP or HTTPS without embedded credentials.'
    );
  }
  return url;
}
