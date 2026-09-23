import type { IRunningSessionManagers } from '@jupyterlab/running';
import { buildIcon, stopIcon } from '@jupyterlab/ui-components';
import type { IDisposable } from '@lumino/disposable';
import { jobRunningItems } from './runs-model';
import type { RunsService } from './runs-service';

export interface IRunningSectionOptions {
  service: RunsService;
  /** Open the Runs view of the project owning `entrypoint`. */
  openRuns: (entrypoint: string) => void;
}

/**
 * A "Lightcone" section in the Running panel and in the "Search Tabs and
 * Running Sessions" dialog, listing materializations started from the UI.
 */
export function addRunningSection(
  managers: IRunningSessionManagers,
  options: IRunningSectionOptions
): IDisposable {
  const { service, openRuns } = options;
  return managers.add({
    name: 'Lightcone',
    running: () =>
      jobRunningItems(service.runningJobs(), {
        open: openRuns,
        stop: (entrypoint, id) => {
          void service.cancel(entrypoint, id).catch(error => {
            console.warn('Could not stop the Lightcone job.', error);
          });
        }
      }).map(item => ({ ...item, icon: () => buildIcon })),
    shutdownAll: () => service.cancelAll(),
    refreshRunning: () => {
      void service.refreshAll();
    },
    runningChanged: service.changed,
    shutdownLabel: 'Stop',
    shutdownAllLabel: 'Stop All',
    shutdownAllConfirmationText:
      'Stop every Lightcone materialization running on this server?',
    shutdownItemIcon: stopIcon,
    supportsMultipleViews: false
  });
}
