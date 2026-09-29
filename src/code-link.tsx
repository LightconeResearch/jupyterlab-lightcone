import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useState } from 'react';
import { fetchRunRecord } from './api';
import { resolveOutputCode, type ICodeReference } from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { serverReadsProject } from './server-features';

/**
 * Resolve on demand: code lookup runs only for an open output detail. Hosts
 * key this by output, so a reference never carries over to another output.
 */
export function JupyterCodeLink({
  contents,
  entrypoint,
  index,
  universe,
  output,
  status,
  onOpen
}: {
  contents: Contents.IManager;
  entrypoint: string;
  index: AnalysisIndex;
  universe: string;
  output: ResolvedOutput;
  /** Hosts that poll `lc status` pass it, so a finished run refreshes the link. */
  status?: OutputStatus;
  onOpen: (relativePath: string) => Promise<void>;
}): React.ReactElement | null {
  const [reference, setReference] = useState<ICodeReference>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    let active = true;
    // The previous reference stays up while a refresh resolves, so the button
    // keeps its focus instead of remounting on every project refresh.
    const publish = (value: ICodeReference | undefined) => {
      if (active)
        setReference(current =>
          current?.relativePath === value?.relativePath &&
          current?.source === value?.source
            ? current
            : value
        );
    };
    const load = async () => {
      if (!isRootAnalysisOutput(index, output)) return undefined;
      let recorded: string | undefined;
      // The server reads run records of local projects; elsewhere the
      // declaration names the script.
      if (serverReadsProject(contents, entrypoint)) {
        try {
          recorded = (
            await fetchRunRecord(
              contents.serverSettings,
              entrypoint,
              universe,
              output,
              state ? { state, detail } : undefined
            )
          )?.recipe;
        } catch (reason) {
          // An unreadable record may name another script than the declaration.
          console.warn(
            `No usable run record for ${output.id}; offering no code link.`,
            reason
          );
          return undefined;
        }
      }
      return resolveOutputCode(contents, entrypoint, index, output, recorded);
    };
    void load().then(publish);
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, universe, output, state, detail]);
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
