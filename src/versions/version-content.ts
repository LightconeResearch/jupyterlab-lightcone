import type { ResolvedOutput } from '@astra-spec/sdk';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../api';
import { readBoundedText } from '../artifact-access';
import {
  JSON_PREVIEW_MAX_BYTES,
  previewFromSource,
  type IBoundedText
} from '../artifact-preview-data';
import {
  delimiterFor,
  isImageFormat,
  outputFormat,
  tableShape,
  tableShapeFromRows,
  type ITableShape
} from './version-model';
import {
  versionContentUrl,
  type IOutputVersion,
  absentReason
} from './versions-api';

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
): Promise<IBoundedText> {
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
  const sample = await readVersionText(
    target,
    commit,
    JSON_PREVIEW_MAX_BYTES,
    signal
  );
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
    return { kind: 'unavailable', reason: absentReason(version) };
  }
  return previewFromSource(
    output,
    {
      url: versionContentUrl(
        target.settings,
        target.entrypoint,
        target.universe,
        target.outputId,
        version.commit
      ),
      size: version.size,
      alt: `${output.label ?? output.id} at ${version.short}`,
      readText: (maxBytes, readSignal) =>
        readVersionText(target, version.commit, maxBytes, readSignal)
    },
    signal
  );
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
