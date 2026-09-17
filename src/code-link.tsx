import type { ResolvedOutput } from '@astra-spec/sdk';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import React, { useEffect, useState } from 'react';
import { resolveOutputCode, type ICodeReference } from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { fetchRunRecord } from './output-provenance';
import type { ILoadedProjectData } from './project-data';

/** Resolve on demand: code lookup runs only for an open output detail. */
export function JupyterCodeLink({
  contents,
  entrypoint,
  data,
  output,
  commands,
  beforeOpen
}: {
  contents: Contents.IManager;
  entrypoint: string;
  data: ILoadedProjectData;
  output: ResolvedOutput;
  commands: CommandRegistry;
  beforeOpen?: () => void;
}): React.ReactElement | null {
  const [reference, setReference] = useState<ICodeReference>();
  useEffect(() => {
    const controller = new AbortController();
    setReference(undefined);
    const load = async () => {
      let recorded: string | undefined;
      // Lightcone records runs only for local root-analysis outputs.
      if (
        isRootAnalysisOutput(data, output) &&
        !contents.driveName(entrypoint)
      ) {
        try {
          recorded = (
            await fetchRunRecord(
              contents,
              entrypoint,
              data.document.universe.universeId,
              output.id,
              controller.signal
            )
          )?.recipe;
        } catch (reason) {
          if (controller.signal.aborted) return;
          console.warn(
            `No usable run record for ${output.id}; using the declared recipe.`,
            reason
          );
        }
      }
      const value = await resolveOutputCode(
        contents,
        entrypoint,
        data,
        output,
        recorded
      );
      if (!controller.signal.aborted) setReference(value);
    };
    load().catch(reason => {
      // The link is optional; a failed lookup only leaves it out.
      console.error(`Could not resolve code for ${output.id}.`, reason);
    });
    return () => controller.abort();
  }, [contents, entrypoint, data, output]);
  if (!reference) return null;
  const open = async () => {
    beforeOpen?.();
    try {
      await commands.execute('docmanager:open', {
        path: reference.path,
        factory: 'Editor'
      });
    } catch (error) {
      await showErrorMessage('Could not open code', String(error));
    }
  };
  return (
    <button
      type="button"
      title={`Open current file: ${reference.relativePath} (from ${reference.source})`}
      aria-label={`Open current code: ${reference.relativePath}`}
      onClick={() => {
        void open();
      }}
    >
      Open code
    </button>
  );
}
