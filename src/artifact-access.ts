import type { CommandRegistry } from '@lumino/commands';
import type { Contents } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import type { ArtifactBinding, ResolvedOutput } from '@astra-spec/sdk';
import {
  metricPreviewFromJson,
  tablePreviewFromDelimited,
  tablePreviewFromRows,
  type ArtifactPreviewData
} from '@astra-spec/ui/lib';
import { projectDirectory } from './project-data';

const TABLE_PREVIEW_ROWS = 30;
const TABLE_PREVIEW_COLUMNS = 30;
const TABLE_PREVIEW_RANGE_BYTES = 65_536;
const JSON_PREVIEW_MAX_BYTES = 2_000_000;
const TABLE_DELIMITERS = new Map([
  ['csv', ','],
  ['tsv', '\t']
]);
const IMAGE_FORMATS = new Set([
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp'
]);

/** Read at most the requested bytes, including when a server ignores Range. */
export async function readBoundedText(
  response: Pick<Response, 'body'>,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    throw new Error('The artifact response has no readable body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) {
        return { text: text + decoder.decode(), truncated: false };
      }
      const available = value.subarray(0, maxBytes - bytes);
      bytes += available.byteLength;
      text += decoder.decode(available, { stream: true });
    }
    // Do not read a further chunk just to determine the total size.
    await reader.cancel();
    return { text: text + decoder.decode(), truncated: true };
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withCacheToken(url: string, cacheToken: string): string {
  const hashIndex = url.indexOf('#');
  const base = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : url.slice(hashIndex);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}astra-cache-token=${encodeURIComponent(cacheToken)}${fragment}`;
}

/** Resolve SDK artifact bindings through the current Jupyter contents drive. */
export class JupyterArtifactAccess {
  constructor(
    private readonly contents: Contents.IManager,
    entrypoint: string,
    bindings: readonly ArtifactBinding[],
    private readonly commands: CommandRegistry
  ) {
    this._projectRoot = projectDirectory(entrypoint);
    this._bindingByOutputPath = new Map(
      bindings.map(binding => [binding.outputPath, binding])
    );
  }

  bindingFor(output: ResolvedOutput): ArtifactBinding | undefined {
    return this._bindingByOutputPath.get(output.canonicalPath);
  }

  async getUrl(output: ResolvedOutput): Promise<string> {
    const binding = this.bindingFor(output);
    if (!binding) {
      throw new Error(`Output ${output.canonicalPath} is not materialized.`);
    }
    const path = this.contents.resolvePath(this._projectRoot, binding.path);
    const url = await this.contents.getDownloadUrl(path);
    return withCacheToken(url, binding.cacheToken);
  }

  async getPreview(
    output: ResolvedOutput,
    signal?: AbortSignal
  ): Promise<ArtifactPreviewData> {
    const binding = this.bindingFor(output);
    if (!binding || !output.artifact) {
      return {
        kind: 'unavailable',
        reason: 'This output has not been materialized.'
      };
    }
    const format = (output.format ?? '').replace(/^\./, '').toLowerCase();
    const url = await this.getUrl(output);

    if (output.type === 'figure' && IMAGE_FORMATS.has(format)) {
      return { kind: 'image', url };
    }

    const delimiter = TABLE_DELIMITERS.get(format);
    if (output.type === 'table' && delimiter !== undefined) {
      const response = await ServerConnection.makeRequest(
        url,
        {
          headers: { Range: `bytes=0-${TABLE_PREVIEW_RANGE_BYTES - 1}` },
          signal
        },
        this.contents.serverSettings
      );
      if (!response.ok) {
        throw await ServerConnection.ResponseError.create(response);
      }
      const sample = await readBoundedText(response, TABLE_PREVIEW_RANGE_BYTES);
      const table = tablePreviewFromDelimited(sample.text, {
        delimiter,
        maxRows: TABLE_PREVIEW_ROWS,
        maxColumns: TABLE_PREVIEW_COLUMNS,
        sourceTruncated:
          sample.truncated ||
          (response.status === 206 &&
            output.artifact.byteSize > TABLE_PREVIEW_RANGE_BYTES)
      });
      return table;
    }

    if (
      (output.type === 'table' || output.type === 'metric') &&
      format === 'json' &&
      output.artifact.byteSize <= JSON_PREVIEW_MAX_BYTES
    ) {
      const response = await ServerConnection.makeRequest(
        url,
        { signal },
        this.contents.serverSettings
      );
      if (!response.ok) {
        throw await ServerConnection.ResponseError.create(response);
      }
      const sample = await readBoundedText(response, JSON_PREVIEW_MAX_BYTES);
      if (sample.truncated) {
        return {
          kind: 'unavailable',
          reason: 'The JSON artifact exceeds the preview limit.'
        };
      }
      try {
        const value: unknown = JSON.parse(sample.text);
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
      } catch {
        // Fall through to the unavailable preview below.
      }
      return {
        kind: 'unavailable',
        reason: `The file is not a JSON ${output.type}.`
      };
    }

    return {
      kind: 'unavailable',
      reason: format
        ? `No bounded preview is available for .${format} artifacts.`
        : 'This output does not declare an artifact format.'
    };
  }

  async open(output: ResolvedOutput): Promise<void> {
    const binding = this.bindingFor(output);
    if (!binding) {
      throw new Error(`Output ${output.canonicalPath} is not materialized.`);
    }
    await this.openPath(binding.path);
  }

  /** Open a project file in a JupyterLab document tab, reusing an open one. */
  async openPath(relativePath: string, factory?: string): Promise<void> {
    const path = this.contents.resolvePath(this._projectRoot, relativePath);
    await this.commands.execute('docmanager:open', { path, factory });
  }

  private readonly _bindingByOutputPath: ReadonlyMap<string, ArtifactBinding>;
  private readonly _projectRoot: string;
}
