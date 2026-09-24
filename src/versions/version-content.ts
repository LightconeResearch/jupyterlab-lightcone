import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  metricPreviewFromJson,
  tablePreviewFromDelimited,
  tablePreviewFromRows,
  type ArtifactPreviewData
} from '@astra-spec/ui/lib';
import { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { readBoundedText } from '../artifact-access';
import {
  delimiterFor,
  isImageFormat,
  outputFormat,
  tableShape,
  tableShapeFromRows,
  type ITableShape
} from './version-model';
import { versionContentUrl, type IOutputVersion } from './versions-api';

const TABLE_PREVIEW_ROWS = 30;
const TABLE_PREVIEW_COLUMNS = 30;
const TABLE_SAMPLE_BYTES = 65_536;
const JSON_MAX_BYTES = 2_000_000;
/** Whole tables are read for shape comparison, up to this many bytes. */
const TABLE_SHAPE_BYTES = 4_000_000;

/** What a version stepper needs to name a version's bytes. */
export interface IVersionTarget {
  settings: ServerConnection.ISettings;
  entrypoint: string;
  universe: string;
  outputId: string;
}

/** Read up to `maxBytes` of a version's content as text. */
export async function readVersionText(
  target: IVersionTarget,
  commit: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  const url = versionContentUrl(
    target.settings,
    target.entrypoint,
    target.universe,
    target.outputId,
    commit
  );
  const response = await ServerConnection.makeRequest(
    url,
    { signal },
    target.settings
  );
  if (!response.ok) {
    throw new RequestError(
      'Versions',
      await ServerConnection.ResponseError.create(response)
    );
  }
  return readBoundedText(response, maxBytes);
}

/** Parse a version's JSON content within the preview size limit. */
export async function readVersionJson(
  target: IVersionTarget,
  commit: string,
  signal?: AbortSignal
): Promise<unknown> {
  const sample = await readVersionText(target, commit, JSON_MAX_BYTES, signal);
  if (sample.truncated)
    throw new Error('The JSON artifact exceeds the preview limit.');
  return JSON.parse(sample.text) as unknown;
}

/**
 * The shape of a table version: a delimited file read whole when small
 * enough, or a JSON array of rows within the JSON preview limit.
 */
export async function readVersionTableShape(
  target: IVersionTarget,
  commit: string,
  format: string,
  signal?: AbortSignal
): Promise<ITableShape> {
  if (format === 'json') {
    const shape = tableShapeFromRows(
      await readVersionJson(target, commit, signal)
    );
    if (!shape) throw new Error('The file is not a JSON table.');
    return shape;
  }
  const delimiter = delimiterFor(format);
  if (delimiter === undefined)
    throw new Error(`No table shape is available for .${format} artifacts.`);
  const sample = await readVersionText(
    target,
    commit,
    TABLE_SHAPE_BYTES,
    signal
  );
  return tableShape(sample.text, delimiter, sample.truncated);
}

/**
 * Bounded preview data for an output's bytes at one commit, using the same
 * limits as the current artifact preview.
 */
export async function previewForVersion(
  target: IVersionTarget,
  output: ResolvedOutput,
  version: IOutputVersion,
  signal?: AbortSignal
): Promise<ArtifactPreviewData> {
  if (!version.present) {
    return {
      kind: 'unavailable',
      reason: 'The bytes of this version are kept by git-annex'
    };
  }
  const format = outputFormat(output);
  if (output.type === 'figure' && isImageFormat(format)) {
    return {
      kind: 'image',
      url: versionContentUrl(
        target.settings,
        target.entrypoint,
        target.universe,
        target.outputId,
        version.commit
      ),
      alt: `${output.label ?? output.id} at ${version.short}`
    };
  }
  const delimiter = delimiterFor(format);
  if (output.type === 'table' && delimiter !== undefined) {
    const sample = await readVersionText(
      target,
      version.commit,
      TABLE_SAMPLE_BYTES,
      signal
    );
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
    if (version.size !== null && version.size > JSON_MAX_BYTES) {
      return {
        kind: 'unavailable',
        reason: 'The JSON artifact exceeds the preview limit.'
      };
    }
    let value: unknown;
    try {
      value = await readVersionJson(target, version.commit, signal);
    } catch (error) {
      // Only a parse failure means the bytes are not JSON; a request error or
      // a file past the limit (its size unknown until read) says so itself.
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
  return {
    kind: 'unavailable',
    reason: format
      ? `No bounded preview is available for .${format} artifacts.`
      : 'This output does not declare an artifact format.'
  };
}

/** How two versions of an output can be compared. */
export type CompareMode = 'image' | 'metric' | 'table' | 'none';

/**
 * Figures compare as images, JSON metrics by numeric deltas, and tables
 * (CSV, TSV or a JSON array of rows) by shape: rows and changed columns.
 */
export function compareModeFor(output: ResolvedOutput): CompareMode {
  const format = outputFormat(output);
  if (output.type === 'figure' && isImageFormat(format)) return 'image';
  if (output.type === 'metric' && format === 'json') return 'metric';
  if (
    output.type === 'table' &&
    (format === 'json' || delimiterFor(format) !== undefined)
  )
    return 'table';
  return 'none';
}
