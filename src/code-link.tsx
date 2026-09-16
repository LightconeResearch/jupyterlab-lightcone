import type { ResolvedOutput } from '@astra-spec/sdk';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import React, { useEffect, useMemo, useState } from 'react';
import type { ILoadedProjectData } from './project-data';
import { resolveOutputCode, type ICodeReference } from './code-access';

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
  // One identity for the lookup inputs: the effect and the staleness guard
  // cannot drift apart as the resolver's arguments change.
  const inputs = useMemo(
    () => ({ contents, entrypoint, data, output }),
    [contents, entrypoint, data, output]
  );
  const [resolved, setResolved] = useState<{
    inputs: typeof inputs;
    reference?: ICodeReference;
  }>();
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let active = true;
    void resolveOutputCode(
      inputs.contents,
      inputs.entrypoint,
      inputs.data,
      inputs.output
    ).then(reference => {
      if (active) setResolved({ inputs, reference });
    });
    return () => {
      active = false;
    };
  }, [inputs]);
  const reference =
    resolved?.inputs === inputs ? resolved.reference : undefined;
  if (!reference) return null;
  const open = async () => {
    setOpening(true);
    try {
      beforeOpen?.();
      // Verify again before opening; docmanager can create a missing file.
      const file = await contents.get(reference.path, { content: false });
      if (file.type !== 'file')
        throw new Error('The code file is no longer available.');
      await commands.execute('docmanager:open', {
        path: reference.path,
        factory: 'Editor'
      });
    } catch (error) {
      await showErrorMessage('Could not open code', String(error));
    } finally {
      setOpening(false);
    }
  };
  return (
    <button
      type="button"
      title={`Open current file: ${reference.relativePath} (from ${reference.source})`}
      aria-label={`Open current code: ${reference.relativePath}`}
      disabled={opening}
      onClick={() => {
        void open();
      }}
    >
      Open code
    </button>
  );
}
