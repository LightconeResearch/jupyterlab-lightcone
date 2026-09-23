import { Notification } from '@jupyterlab/apputils';
import type { IJob } from './runs-api';
import { describeTargets, jobOutcome } from './runs-model';
import type { RunsService } from './runs-service';

/** Toasts are cut at 140 characters; keep the cut visible. */
const TOAST_LIMIT = 140;

export interface IMaterializeOptions {
  service: RunsService;
  entrypoint: string;
  targets: string[];
  refresh: boolean;
  /** Opens the project's Runs view; offered on every toast. */
  openRuns: () => void;
}

function toast(message: string): string {
  return message.length > TOAST_LIMIT
    ? `${message.slice(0, TOAST_LIMIT - 1)}…`
    : message;
}

/**
 * Start `lc materialize` and follow it with one notification until it ends:
 * a success, the engine's refusal or failure, or a plain note when stopped.
 * Rejects only when the job cannot start, so the caller can say why in place.
 */
export async function startMaterialization(
  options: IMaterializeOptions
): Promise<IJob> {
  const { service, entrypoint, targets, refresh, openRuns } = options;
  const job = await service.start(entrypoint, { targets, refresh });
  const actions: Notification.IAction[] = [
    { label: 'Open runs', displayType: 'link', callback: () => openRuns() }
  ];
  const id = Notification.emit(
    toast(`Materializing ${describeTargets(targets)}…`),
    'in-progress',
    { autoClose: false, actions }
  );
  void service.whenFinished(entrypoint, job.id).then(
    finished => {
      // A stop is the user's own doing: it is news, not an error to dismiss.
      const type: Notification.TypeOptions =
        finished.state === 'succeeded'
          ? 'success'
          : finished.state === 'cancelled'
            ? 'info'
            : 'error';
      Notification.update({
        id,
        message: toast(jobOutcome(finished)),
        type,
        autoClose: type === 'error' ? false : 8000,
        actions
      });
    },
    reason => {
      Notification.update({
        id,
        message: toast(
          reason instanceof Error ? reason.message : String(reason)
        ),
        type: 'error',
        autoClose: false,
        actions
      });
    }
  );
  return job;
}
