import React, { useState } from 'react';
import type { CommandRegistry } from '@lumino/commands';
import { showErrorMessage } from '@jupyterlab/apputils';
import { Button } from '@astra-spec/ui/primitives';
import type { IElementReference } from './element-reference';
import { CommandIDs } from './commands';

/** Stage a record in the composer; sending remains a separate user action. */
export function AddToChat({
  commands,
  reference,
  onAdded
}: {
  commands?: CommandRegistry;
  reference: IElementReference;
  onAdded?: () => void;
}): React.ReactElement | null {
  const [pending, setPending] = useState(false);
  if (!commands?.hasCommand(CommandIDs.discuss)) return null;
  return (
    <Button
      size="small"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void commands
          .execute(CommandIDs.discuss, { ...reference })
          .then(result => {
            if (result) onAdded?.();
          })
          .catch(reason =>
            showErrorMessage('Could not add element to chat', reason)
          )
          .finally(() => setPending(false));
      }}
    >
      {pending ? 'Adding…' : 'Add to chat'}
    </Button>
  );
}
