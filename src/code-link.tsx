import type { ResolvedOutput } from '@astra-spec/sdk';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import React, { useEffect, useState } from 'react';
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
  const [reference, setReference] = useState<ICodeReference>();
  useEffect(() => {
    let active = true;
    setReference(undefined);
    void resolveOutputCode(contents, entrypoint, data, output).then(
      value => {
        if (active) setReference(value);
      },
      error => {
        // The link is optional; a failed lookup only leaves it out.
        console.error(`Could not resolve code for ${output.id}.`, error);
      }
    );
    return () => {
      active = false;
    };
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
