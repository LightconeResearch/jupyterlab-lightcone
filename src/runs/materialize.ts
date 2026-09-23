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

/** A job that ended in a state other than `succeeded`. */
export class JobFailure extends Error {
  constructor(readonly job: IJob) {
    super(jobOutcome(job));
    this.name = 'JobFailure';
  }
}

function toast(message: string): string {
  return message.length > TOAST_LIMIT
    ? `${message.slice(0, TOAST_LIMIT - 1)}…`
    : message;
}

/**
 * Start `lc materialize` and follow it with one notification until it ends.
 * Rejects only when the job cannot start, so the caller can say why in place.
 */
export async function startMaterialization(
  options: IMaterializeOptions
): Promise<IJob> {
  const { service, entrypoint, targets, refresh, openRuns } = options;
  const job = await service.start(entrypoint, { targets, refresh });
  // The notification wants a JSON result, so the outcome travels as text.
  const settled: Promise<string> = service
    .whenFinished(entrypoint, job.id)
    .then(finished => {
      if (finished.state !== 'succeeded') {
        throw new JobFailure(finished);
      }
      return jobOutcome(finished);
    });
  const actions: Notification.IAction[] = [
    { label: 'Open runs', displayType: 'link', callback: () => openRuns() }
  ];
  Notification.promise(settled, {
    pending: {
      message: toast(`Materializing ${describeTargets(targets)}…`),
      options: { actions }
    },
    success: {
      message: result =>
        toast(
          typeof result === 'string' ? result : 'Materialization finished.'
        ),
      options: { actions, autoClose: 8000 }
    },
    error: {
      message: reason =>
        toast(
          reason instanceof JobFailure
            ? jobOutcome(reason.job)
            : reason instanceof Error
              ? reason.message
              : String(reason)
        ),
      options: { actions, autoClose: false }
    }
  });
  return job;
}
