import { RunningSessionManagers } from '@jupyterlab/running';
import { buildIcon, stopIcon } from '@jupyterlab/ui-components';
import { Signal } from '@lumino/signaling';
import { lightconeIcon } from '../../icons';
import type { IBusySession } from '../../sessions/session-service';
import { addRunningSection } from '../running-section';
import { cancelRun, getRun, listRuns, startRun } from '../runs-api';
import { flush, job, runsHost } from './runs-fixtures';

jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

beforeEach(() => {
  jest.mocked(listRuns).mockReset();
  jest.mocked(startRun).mockReset();
  jest.mocked(cancelRun).mockReset();
  jest.mocked(getRun).mockReset();
  // Running jobs are polled; these reads never answer.
  jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
});

it('lists running jobs of every project with open and stop actions', async () => {
  const h = runsHost();
  try {
    jest.mocked(listRuns).mockImplementation(async (_settings, entrypoint) =>
      entrypoint === 'proj/astra.yaml'
        ? { runs: [], jobs: [job({ targets: ['a'] })] }
        : {
            runs: [],
            jobs: [
              job({ id: 'job-2', project: '', refresh: true }),
              job({ id: 'job-0', project: '', state: 'succeeded' })
            ]
          }
    );
    await h.service.refresh('proj/astra.yaml');
    await h.service.refresh('astra.yaml');
    const managers = new RunningSessionManagers();
    const openRuns = jest.fn();
    addRunningSection(managers, { service: h.service, openRuns });
    const [section] = managers.items();
    expect(section.name).toBe('Lightcone');
    expect(section.runningChanged).toBe(h.service.changed);
    expect(section.shutdownItemIcon).toBe(stopIcon);
    expect(section.supportsMultipleViews).toBe(false);

    const items = section.running({ mode: 'list' });
    expect(items.map(item => item.label())).toEqual([
      'Materialize a',
      'Refresh everything'
    ]);
    expect(items.map(item => item.context)).toEqual([
      'proj/astra.yaml',
      'astra.yaml'
    ]);
    const icon = items[0].icon;
    expect(typeof icon === 'function' ? icon() : icon).toBe(buildIcon);

    items[1].open?.();
    expect(openRuns).toHaveBeenCalledWith('astra.yaml');

    jest.mocked(cancelRun).mockResolvedValue(undefined);
    items[0].shutdown?.();
    await flush();
    expect(cancelRun).toHaveBeenCalledWith(
      expect.anything(),
      'proj/astra.yaml',
      'job-1'
    );

    jest.mocked(cancelRun).mockClear();
    section.shutdownAll();
    await flush();
    expect(jest.mocked(cancelRun).mock.calls.map(call => call[2])).toEqual([
      'job-1',
      'job-2'
    ]);

    jest.mocked(listRuns).mockClear();
    section.refreshRunning();
    await flush();
    expect(jest.mocked(listRuns).mock.calls.map(call => call[1])).toEqual([
      'proj/astra.yaml',
      'astra.yaml'
    ]);
  } finally {
    h.dispose();
  }
});

it('reports a stop that fails without throwing from the panel', async () => {
  const h = runsHost();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [job()] });
    await h.service.refresh('proj/astra.yaml');
    const managers = new RunningSessionManagers();
    const added = addRunningSection(managers, {
      service: h.service,
      openRuns: jest.fn()
    });
    jest.mocked(cancelRun).mockRejectedValue(new Error('offline'));
    managers.items()[0].running({ mode: 'list' })[0].shutdown?.();
    await flush();
    expect(warn).toHaveBeenCalledWith(
      'Could not stop the Lightcone job.',
      expect.any(Error)
    );
    // Removing the section takes it out of the panel.
    added.dispose();
    expect(managers.items()).toEqual([]);
  } finally {
    warn.mockRestore();
    h.dispose();
  }
});

it('lists busy sessions after the jobs, without a stop action', async () => {
  const h = runsHost();
  try {
    jest.mocked(listRuns).mockResolvedValue({
      runs: [],
      jobs: [job({ targets: ['a'] })]
    });
    await h.service.refresh('proj/astra.yaml');
    const managers = new RunningSessionManagers();
    const changed = new Signal<object, void>({});
    const open = jest.fn();
    let busy: IBusySession[] = [
      { path: 'proj/chats/fit.chat', title: 'Fit the model', state: 'working' },
      { path: 'proj/chats/plot.chat', title: 'Plot', state: 'attention' }
    ];
    const section = addRunningSection(managers, {
      service: h.service,
      openRuns: jest.fn(),
      sessions: { busy: () => busy, changed, open, icon: lightconeIcon }
    });
    const [manager] = managers.items();
    const items = manager.running({ mode: 'list' });
    expect(items.map(item => item.label())).toEqual([
      'Materialize a',
      'Fit the model',
      'Plot'
    ]);
    expect(items.map(item => item.detail?.())).toEqual([
      expect.any(String),
      'working',
      'needs input'
    ]);
    expect(items[1].shutdown).toBeUndefined();
    items[2].open?.();
    expect(open).toHaveBeenCalledWith('proj/chats/plot.chat');

    // Either source redraws the section.
    const redraws = jest.fn();
    manager.runningChanged.connect(redraws);
    busy = [];
    changed.emit();
    expect(redraws).toHaveBeenCalledTimes(1);
    expect(manager.running({ mode: 'list' })).toHaveLength(1);
    section.dispose();
    changed.emit();
    expect(redraws).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});
