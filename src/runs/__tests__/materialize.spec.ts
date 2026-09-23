import { Notification } from '@jupyterlab/apputils';
import { startMaterialization } from '../materialize';
import { cancelRun, getRun, listRuns, startRun, type IJob } from '../runs-api';
import { FORGOTTEN_JOB_MESSAGE } from '../runs-service';
import { job, refused, runsHost, until } from './runs-fixtures';

jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

const ENTRYPOINT = 'proj/astra.yaml';

/** The one notification a materialization shows. */
function toast(): Notification.INotification {
  const [notification, ...others] = Notification.manager.notifications;
  expect(others).toEqual([]);
  return notification;
}

/** Start a job for `targets`, end it on the event bus with `record`. */
async function follow(
  targets: string[],
  record: IJob,
  lines: string[] = []
): Promise<{ openRuns: jest.Mock; notification: Notification.INotification }> {
  const h = runsHost();
  try {
    jest.mocked(startRun).mockResolvedValue(job({ targets }));
    jest.mocked(getRun).mockResolvedValue(record);
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [record] });
    const openRuns = jest.fn();
    const started = await startMaterialization({
      service: h.service,
      entrypoint: ENTRYPOINT,
      targets,
      refresh: false,
      openRuns
    });
    expect(started.state).toBe('running');
    expect(toast().type).toBe('in-progress');
    for (const line of lines) {
      h.emit({ id: 'job-1', project: 'proj', state: 'running', line });
    }
    h.emit({ id: 'job-1', project: 'proj', state: record.state, line: null });
    await until(() => toast().type !== 'in-progress');
    return { openRuns, notification: toast() };
  } finally {
    h.dispose();
  }
}

beforeEach(() => {
  Notification.manager.dismiss();
  jest.mocked(listRuns).mockReset();
  jest.mocked(startRun).mockReset();
  jest.mocked(getRun).mockReset();
  jest.mocked(cancelRun).mockReset();
});

it('names what it materializes while the job runs', async () => {
  const h = runsHost();
  try {
    jest.mocked(startRun).mockResolvedValue(job({ targets: ['a', 'b'] }));
    jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
    await startMaterialization({
      service: h.service,
      entrypoint: ENTRYPOINT,
      targets: ['a', 'b'],
      refresh: true,
      openRuns: jest.fn()
    });
    expect(startRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['a', 'b'],
      refresh: true
    });
    expect(toast().message).toBe('Materializing a, b…');
  } finally {
    h.dispose();
  }
});

it('reports what a successful job made, from its record', async () => {
  const { notification, openRuns } = await follow(
    ['hubble_diagram'],
    job({
      state: 'succeeded',
      exit: 0,
      finished: '2026-09-23T12:00:00.000Z',
      report: { ok: true, made: ['baseline/hubble_diagram'] }
    })
  );
  expect(notification.type).toBe('success');
  expect(notification.message).toBe(
    'Materialized 1 output: baseline/hubble_diagram'
  );
  expect(notification.options.autoClose).toBe(8000);
  notification.options.actions?.[0].callback(new MouseEvent('click'));
  expect(openRuns).toHaveBeenCalledTimes(1);
});

it('reports the failed outputs of a failed job, not its first line', async () => {
  const report = { ok: false, failed: ['baseline/table'] };
  const lines = ['materializing baseline/table', JSON.stringify(report)];
  const { notification } = await follow(
    ['table'],
    job({ state: 'failed', exit: 1, lines, report }),
    lines
  );
  expect(notification.type).toBe('error');
  expect(notification.message).toBe('1 output failed: baseline/table');
  expect(notification.options.autoClose).toBe(false);
  expect(notification.options.actions?.[0].label).toBe('Open runs');
});

it('quotes the engine refusal and keeps long messages within a toast', async () => {
  const refusal = `the tree is dirty: ${'src/plot.py '.repeat(20)}`;
  const { notification } = await follow(
    [],
    job({ state: 'failed', exit: 1, lines: [refusal, '  M src/plot.py'] }),
    [refusal]
  );
  expect(notification.type).toBe('error');
  expect(notification.message).toHaveLength(140);
  expect(
    notification.message.startsWith('the tree is dirty: src/plot.py')
  ).toBe(true);
  expect(notification.message.endsWith('…')).toBe(true);
});

it('fails the toast when the server forgets the job', async () => {
  const h = runsHost();
  try {
    jest.mocked(startRun).mockResolvedValue(job());
    jest.mocked(getRun).mockRejectedValue(refused(404));
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [] });
    await startMaterialization({
      service: h.service,
      entrypoint: ENTRYPOINT,
      targets: [],
      refresh: false,
      openRuns: jest.fn()
    });
    await until(() => toast().type !== 'in-progress');
    expect(toast().type).toBe('error');
    expect(toast().message).toBe(FORGOTTEN_JOB_MESSAGE);
  } finally {
    h.dispose();
  }
});

it('rejects without a toast when the job cannot start', async () => {
  const h = runsHost();
  try {
    jest.mocked(startRun).mockRejectedValue(refused(403));
    await expect(
      startMaterialization({
        service: h.service,
        entrypoint: ENTRYPOINT,
        targets: [],
        refresh: false,
        openRuns: jest.fn()
      })
    ).rejects.toThrow('403');
    expect(Notification.manager.notifications).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('says plainly that a job was stopped, without an error to dismiss', async () => {
  const { notification } = await follow(
    ['cosmology_contours'],
    job({ state: 'cancelled', exit: -15, finished: '2026-09-23T12:00:00.000Z' })
  );
  expect(notification.type).toBe('info');
  expect(notification.message).toBe('Materialization stopped.');
  expect(notification.options.autoClose).toBe(8000);
});
