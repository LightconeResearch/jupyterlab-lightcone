import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useState } from 'react';
import { resolveOutputCode, type ICodeReference } from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { fetchRunRecord } from './output-provenance';

/** Resolve on demand: code lookup runs only for an open output detail. */
export function JupyterCodeLink({
  contents,
  entrypoint,
  index,
  universe,
  output,
  onOpen
}: {
  contents: Contents.IManager;
  entrypoint: string;
  index: AnalysisIndex;
  universe: string;
  output: ResolvedOutput;
  onOpen: (relativePath: string) => Promise<void>;
}): React.ReactElement | null {
  const [reference, setReference] = useState<ICodeReference>();
  useEffect(() => {
    let active = true;
    setReference(undefined);
    if (!isRootAnalysisOutput(index, output)) return;
    const load = async () => {
      let recorded: string | undefined;
      try {
        recorded = (
          await fetchRunRecord(contents, entrypoint, index, universe, output)
        )?.recipe;
      } catch (reason) {
        if (!active) return;
        console.warn(
          `No usable run record for ${output.id}; using the declared recipe.`,
          reason
        );
      }
      const value = await resolveOutputCode(
        contents,
        entrypoint,
        index,
        output,
        recorded
      );
      if (active) setReference(value);
    };
    void load();
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, universe, output]);
  if (!reference) return null;
  return (
    <button
      type="button"
      title={`Open current file: ${reference.relativePath} (from ${reference.source})`}
      onClick={() => {
        void onOpen(reference.relativePath);
      }}
    >
      Open code
    </button>
  );
}
