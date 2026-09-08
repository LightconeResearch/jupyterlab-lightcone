import type { Contents } from '@jupyterlab/services';
import type { InventoryProps } from '@astra-spec/ui/views';
import React, { useMemo } from 'react';
import { JupyterArtifactAccess } from './artifact-access';
import { JupyterArtifactPreview } from './artifact-preview';
import { loadPdfJs } from './pdf-runtime';
import type { ILoadedProjectData } from './project-data';

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
  return {
    document: data.document,
    index: data.index,
    paperMetadata: data.papers,
    renderArtifact: (output, options) => (
      <JupyterArtifactPreview
        key={`${output.canonicalPath}:${access.bindingFor(output)?.cacheToken ?? ''}`}
        access={access}
        compact={options.compact}
        output={output}
      />
    ),
    onOpenArtifact: output => access.open(output),
    loadPdfJs,
    onFetchPaper
  };
}
