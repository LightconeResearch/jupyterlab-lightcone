import type { ResolvedOutput } from '@astra-spec/sdk';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../api';
import { readBoundedText } from '../artifact-access';
import { previewFromSource, type IBoundedText } from '../artifact-preview-data';
import {
  versionContentUrl,
  type IOutputVersion,
  absentReason
} from './versions-api';

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
    version.file
      ? { ...output, format: version.file.split('.').pop() }
      : output,
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
