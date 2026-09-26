import type { CommandRegistry } from '@lumino/commands';
import type { Contents } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import type { ArtifactBinding, ResolvedOutput } from '@astra-spec/sdk';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import {
  previewFromSource,
  type IArtifactSource,
  type IBoundedText
} from './artifact-preview-data';
import { projectDirectory } from './project-data';

/** Read at most the requested bytes, including when a server ignores Range. */
export async function readBoundedText(
  response: Pick<Response, 'body'>,
  maxBytes: number
): Promise<IBoundedText> {
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

  /** Bounded preview data for the output's current artifact. */
  async getPreview(
    output: ResolvedOutput,
    signal?: AbortSignal
  ): Promise<ArtifactPreviewData> {
    const binding = this.bindingFor(output);
    const artifact = output.artifact;
    if (!binding || !artifact) {
      return {
        kind: 'unavailable',
        reason: 'This output has not been materialized.'
      };
    }
    const url = await this.getUrl(output);
    const source: IArtifactSource = {
      url,
      size: artifact.byteSize,
      readText: async (maxBytes, readSignal) => {
        // Ask for a range; a drive that serves the whole file is cut while read.
        const response = await ServerConnection.makeRequest(
          url,
          { headers: { Range: `bytes=0-${maxBytes - 1}` }, signal: readSignal },
          this.contents.serverSettings
        );
        if (!response.ok) {
          throw await ServerConnection.ResponseError.create(response);
        }
        const sample = await readBoundedText(response, maxBytes);
        return {
          text: sample.text,
          truncated:
            sample.truncated ||
            (response.status === 206 && artifact.byteSize > maxBytes)
        };
      }
    };
    return previewFromSource(output, source, signal);
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
