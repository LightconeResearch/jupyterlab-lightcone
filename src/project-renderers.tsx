import type { Contents } from '@jupyterlab/services';
import type { ArtifactRenderer } from '@astra-spec/ui/components';
import { isVisualOutput } from '@astra-spec/ui/model';
import type { InventoryProps } from '@astra-spec/ui/views';
import React, { useMemo } from 'react';
import { JupyterArtifactAccess } from './artifact-access';
import { JupyterArtifactPreview } from './artifact-preview';
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

/** Supply Jupyter file access and pdf.js through ASTRA UI's host slots. */
export function useProjectRenderers(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  onFetchPaper: (doi: string) => void
): InventoryProps {
  const access = useMemo(
    () => new JupyterArtifactAccess(contents, entrypoint, data.bindings),
    [contents, entrypoint, data.bindings]
  );
  const renderArtifact = useMemo(() => hostArtifactRenderer(access), [access]);
  return {
    document: data.document,
    index: data.index,
    paperMetadata: data.papers,
    renderArtifact,
    onOpenArtifact: output => access.open(output),
    loadPdfJs,
    onFetchPaper
  };
}
