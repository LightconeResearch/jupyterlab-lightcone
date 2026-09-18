import type { ResolvedOutput } from '@astra-spec/sdk';
import type { CommandRegistry } from '@lumino/commands';
import type { Contents } from '@jupyterlab/services';
import type { ArtifactRenderer } from '@astra-spec/ui/components';
import { isVisualOutput, type OutputStatus } from '@astra-spec/ui/model';
import type { InventoryProps } from '@astra-spec/ui/views';
import { showErrorMessage } from '@jupyterlab/apputils';
import React, { useMemo } from 'react';
import { JupyterArtifactAccess } from './artifact-access';
import { JupyterArtifactPreview } from './artifact-preview';
import { JupyterCodeLink } from './code-link';
import { loadPdfJs } from './pdf-runtime';
import type { ILoadedProjectData } from './project-data';

/**
 * Bounded artifact previews through ASTRA UI's render slot. Cards and tiles
 * always get a preview; the detail dialog gets one only for figures and
 * tables, the outputs with a picture to frame. Returning `null` for the rest
 * is the slot's way to opt out, so a data file opens in the single-column
 * dialog rather than beside an empty artifact box.
 */
export function hostArtifactRenderer(
  access: JupyterArtifactAccess
): ArtifactRenderer {
  return (output, options) => {
    if (!options.compact && !isVisualOutput(output)) {
      return null;
    }
    return (
      <JupyterArtifactPreview
        key={`${output.canonicalPath}:${access.bindingFor(output)?.cacheToken ?? ''}`}
        access={access}
        compact={options.compact}
        output={output}
      />
    );
  };
}

/**
 * Supply Jupyter file access and pdf.js through ASTRA UI's host slots.
 *
 * `beforeOpenDocument` runs synchronously before any project file opens in a
 * JupyterLab tab, so a host can dismiss its own dialog first. A host that
 * polls `lc status` passes `getOutputStatus`, so code links follow new runs.
 */
export function useProjectRenderers(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  onFetchPaper: (doi: string) => void,
  commands: CommandRegistry,
  beforeOpenDocument?: () => void,
  getOutputStatus?: (output: ResolvedOutput) => OutputStatus | undefined
): InventoryProps {
  const access = useMemo(
    () =>
      new JupyterArtifactAccess(contents, entrypoint, data.bindings, commands),
    [contents, entrypoint, data.bindings, commands]
  );
  const renderArtifact = useMemo(() => hostArtifactRenderer(access), [access]);
  const openDocument = async (
    subject: string,
    open: () => Promise<void>
  ): Promise<void> => {
    beforeOpenDocument?.();
    try {
      await open();
    } catch (reason) {
      await showErrorMessage(`Could not open ${subject}`, String(reason));
    }
  };
  return {
    document: data.document,
    index: data.index,
    paperMetadata: data.papers,
    renderArtifact,
    renderCodeLink: output => (
      <JupyterCodeLink
        key={`${entrypoint}:${data.document.universe.universeId}:${output.canonicalPath}`}
        contents={contents}
        entrypoint={entrypoint}
        index={data.index}
        universe={data.document.universe.universeId}
        output={output}
        status={getOutputStatus?.(output)}
        onOpen={path =>
          openDocument('code', () => access.openPath(path, 'Editor'))
        }
      />
    ),
    onOpenArtifact: output =>
      openDocument('artifact', () => access.open(output)),
    loadPdfJs,
    onFetchPaper
  };
}
