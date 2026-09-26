import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  metricPreviewFromJson,
  tablePreviewFromDelimited,
  tablePreviewFromRows,
  type ArtifactPreviewData
} from '@astra-spec/ui/lib';
import { isRecord } from './api';
import {
  delimiterFor,
  isImageFormat,
  outputFormat
} from './versions/version-model';

/** Rows and columns a table preview shows at most. */
const TABLE_PREVIEW_ROWS = 30;
const TABLE_PREVIEW_COLUMNS = 30;
/** How much of a delimited table is read for its preview. */
export const TABLE_PREVIEW_SAMPLE_BYTES = 65_536;
/** JSON artifacts larger than this are not parsed for a preview. */
export const JSON_PREVIEW_MAX_BYTES = 2_000_000;

/** Text read from an artifact, and whether the byte limit cut it. */
export interface IBoundedText {
  text: string;
  truncated: boolean;
}

/**
 * The bytes of one output artifact, wherever they are kept: the current file
 * on a Contents drive or a committed version the server serves.
 */
export interface IArtifactSource {
  /** Where the bytes are served, for image previews. */
  url: string;
  /** Size of the bytes; null when unknown. */
  size: number | null;
  /** Alternative text of an image preview. */
  alt?: string;
  /** Read at most `maxBytes` of the bytes as text. */
  readText(maxBytes: number, signal?: AbortSignal): Promise<IBoundedText>;
}

/**
 * Bounded preview data for an output's bytes: figures as images, delimited
 * tables from a sample, JSON tables and metrics parsed within a size limit.
 * The current artifact and its committed versions share these limits and
 * reasons, so a version never previews differently from the file itself.
 */
export async function previewFromSource(
  output: ResolvedOutput,
  source: IArtifactSource,
  signal?: AbortSignal
): Promise<ArtifactPreviewData> {
  const format = outputFormat(output);
  if (output.type === 'figure' && isImageFormat(format)) {
    return {
      kind: 'image',
      url: source.url,
      ...(source.alt === undefined ? {} : { alt: source.alt })
    };
  }
  const delimiter = delimiterFor(format);
  if (output.type === 'table' && delimiter !== undefined) {
    const sample = await source.readText(TABLE_PREVIEW_SAMPLE_BYTES, signal);
    return tablePreviewFromDelimited(sample.text, {
      delimiter,
      maxRows: TABLE_PREVIEW_ROWS,
      maxColumns: TABLE_PREVIEW_COLUMNS,
      sourceTruncated: sample.truncated
    });
  }
  if (
    (output.type === 'table' || output.type === 'metric') &&
    format === 'json'
  ) {
    return previewFromJson(output, source, signal);
  }
  return {
    kind: 'unavailable',
    reason: format
      ? `No bounded preview is available for .${format} artifacts.`
      : 'This output does not declare an artifact format.'
  };
}

async function previewFromJson(
  output: ResolvedOutput,
  source: IArtifactSource,
  signal?: AbortSignal
): Promise<ArtifactPreviewData> {
  const tooLarge: ArtifactPreviewData = {
    kind: 'unavailable',
    reason: 'The JSON artifact exceeds the preview limit.'
  };
  if (source.size !== null && source.size > JSON_PREVIEW_MAX_BYTES) {
    return tooLarge;
  }
  // A source whose size is unknown is cut at the limit while it is read.
  const sample = await source.readText(JSON_PREVIEW_MAX_BYTES, signal);
  if (sample.truncated) return tooLarge;
  let value: unknown;
  try {
    value = JSON.parse(sample.text);
  } catch (error) {
    // Only a parse failure means the bytes are not JSON.
    if (!(error instanceof SyntaxError)) throw error;
    return {
      kind: 'unavailable',
      reason: `The file is not a JSON ${output.type}.`
    };
  }
  if (output.type === 'metric') {
    return (
      metricPreviewFromJson(value) ?? {
        kind: 'unavailable',
        reason: 'The file is not a JSON metric.'
      }
    );
  }
  if (Array.isArray(value) && value.every(isRecord)) {
    return tablePreviewFromRows(value, {
      maxRows: TABLE_PREVIEW_ROWS,
      maxColumns: TABLE_PREVIEW_COLUMNS
    });
  }
  return { kind: 'unavailable', reason: 'The file is not a JSON table.' };
}
