import type { CommandRegistry } from '@lumino/commands';
import React, { useEffect, useState } from 'react';
import type { MaterializationStatuses } from '../materialization-status';
import { RunsCommandIDs } from './runs-commands';
import { rematerializeAction } from './runs-model';

export interface IRematerializeButtonProps {
  commands: CommandRegistry;
  /** Contents path of the project's `astra.yaml`. */
  entrypoint: string;
  statuses: MaterializationStatuses | undefined;
  /** Class of the button, so each surface styles it as its own. */
  className?: string;
}

/** Whether the materialize command is registered, following later changes. */
function useMaterializeAvailable(commands: CommandRegistry): boolean {
  const [available, setAvailable] = useState(() =>
    commands.hasCommand(RunsCommandIDs.materialize)
  );
  useEffect(() => {
    const update = (
      _sender: CommandRegistry,
      change: CommandRegistry.ICommandChangedArgs
    ) => {
      if (change.type !== 'changed') {
        setAvailable(commands.hasCommand(RunsCommandIDs.materialize));
      }
    };
    commands.commandChanged.connect(update);
    return () => {
      commands.commandChanged.disconnect(update);
    };
  }, [commands]);
  return available;
}

/**
 * "Rematerialize stale (N)", or "Refresh behind (N)" when nothing is stale,
 * for the results Home and the sidebar list. It starts the job through the
 * materialize command, which follows it with a notification and opens the
 * project's Runs; nothing is shown while every output is current.
 */
export function RematerializeButton({
  commands,
  entrypoint,
  statuses,
  className
}: IRematerializeButtonProps): React.ReactElement | null {
  const available = useMaterializeAvailable(commands);
  const [starting, setStarting] = useState(false);
  const action = rematerializeAction(statuses);
  if (!available || !action) {
    return null;
  }
  return (
    <button
      type="button"
      className={className}
      disabled={starting}
      title={action.targets.join('\n')}
      onClick={() => {
        setStarting(true);
        void commands
          .execute(RunsCommandIDs.materialize, {
            entrypoint,
            targets: action.targets,
            refresh: action.refresh
          })
          .catch(error => {
            // The command reports its own failures; this only keeps the
            // button usable after an unexpected rejection.
            console.warn('Could not start the materialization.', error);
          })
          .finally(() => setStarting(false));
      }}
    >
      {action.label}
    </button>
  );
}
