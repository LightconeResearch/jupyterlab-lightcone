import type {
  IRunningSessionManagers,
  IRunningSessions
} from '@jupyterlab/running';
import { buildIcon, stopIcon, type LabIcon } from '@jupyterlab/ui-components';
import { DisposableSet, type IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import type { IBusySession } from '../sessions/session-service';
import { jobRunningItems } from './runs-model';
import type { RunsService } from './runs-service';

/** Open sessions whose agent is at work, as the Running panel lists them. */
export interface IBusySessionsSource {
  busy(): IBusySession[];
  /** Emitted when a session's activity may have changed. */
  readonly changed: ISignal<unknown, unknown>;
  open(path: string): void;
  icon: LabIcon;
}

export interface IRunningSectionOptions {
  service: RunsService;
  /** Open the Runs view of the project owning `entrypoint`. */
  openRuns: (entrypoint: string) => void;
  /** Sessions whose agent is at work, listed without a stop action. */
  sessions?: IBusySessionsSource | null;
}

/**
 * The busy sessions as running items. They offer no shutdown: stopping an
 * agent belongs to its session, and Stop All names materializations only.
 */
export function sessionRunningItems(
  source: IBusySessionsSource
): IRunningSessions.IRunningItem[] {
  return source.busy().map(session => ({
    label: () => session.title,
    labelTitle: () => `${session.title}\n${session.path}`,
    detail: () => (session.state === 'working' ? 'working' : 'needs input'),
    context: session.path,
    icon: () => source.icon,
    open: () => source.open(session.path)
  }));
}

/**
 * A "Lightcone" section in the Running panel and in the "Search Tabs and
 * Running Sessions" dialog, listing materializations started from the UI,
 * then the open sessions whose agent is working or waiting for input.
 */
export function addRunningSection(
  managers: IRunningSessionManagers,
  options: IRunningSectionOptions
): IDisposable {
  const { service, openRuns, sessions } = options;
  const disposables = new DisposableSet();
  let runningChanged: ISignal<unknown, unknown> = service.changed;
  if (sessions) {
    // One signal for both sources, so the panel redraws on either.
    const combined = new Signal<object, void>({});
    const forward = () => combined.emit();
    service.changed.connect(forward);
    sessions.changed.connect(forward);
    disposables.add({
      isDisposed: false,
      dispose() {
        service.changed.disconnect(forward);
        sessions.changed.disconnect(forward);
        Signal.clearData(combined);
      }
    });
    runningChanged = combined;
  }
  const section = managers.add({
    name: 'Lightcone',
    running: () => [
      ...jobRunningItems(service.runningJobs(), {
        open: openRuns,
        stop: (entrypoint, id) => {
          void service.cancel(entrypoint, id).catch(error => {
            console.warn('Could not stop the Lightcone job.', error);
          });
        }
      }).map(item => ({ ...item, icon: () => buildIcon })),
      ...(sessions ? sessionRunningItems(sessions) : [])
    ],
    shutdownAll: () => service.cancelAll(),
    refreshRunning: () => {
      void service.refreshAll();
    },
    runningChanged,
    shutdownLabel: 'Stop',
    shutdownAllLabel: 'Stop All',
    shutdownAllConfirmationText:
      'Stop every Lightcone materialization running on this server?',
    shutdownItemIcon: stopIcon,
    supportsMultipleViews: false
  });
  disposables.add(section);
  return disposables;
}
