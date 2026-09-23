import type { Event } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { Stream } from '@lumino/signaling';
import {
  cancelRun,
  getRun,
  JOB_EVENT_SCHEMA,
  listRuns,
  startRun,
  type IJob,
  type IRunRecord
} from '../runs-api';
import { RunsService } from '../runs-service';

jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

const ENTRYPOINT = 'proj/astra.yaml';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** The server's event bus, as the frontend sees it. */
class FakeEvents implements Event.IManager {
  readonly serverSettings = ServerConnection.makeSettings();
  readonly stream: Stream<Event.IManager, Event.Emission>;
  isDisposed = false;

  constructor() {
    this.stream = new Stream<Event.IManager, Event.Emission>(this);
  }

  dispose(): void {
    this.isDisposed = true;
    this.stream.stop();
  }

  emit(): Promise<void> {
    return Promise.resolve();
  }
}

function job(overrides: Partial<IJob> = {}): IJob {
  return {
    id: 'job-1',
    project: 'proj',
    targets: [],
    refresh: false,
    state: 'running',
    started: '2026-09-23T11:58:30.000Z',
    finished: null,
    exit: null,
    lines: [],
    report: null,
    ...overrides
  };
}

function run(overrides: Partial<IRunRecord> = {}): IRunRecord {
  return {
    commit: 'a889877deadbeef',
    short: 'a889877',
    time: '2026-09-23T09:00:00.000Z',
    output: 'hubble_diagram',
    universe: 'baseline',
    exit: 0,
    cmd: 'python src/plot.py',
    inputs: [],
    outputs: [],
    ...overrides
  };
}

function host() {
  const events = new FakeEvents();
  const service = new RunsService(events.serverSettings, events);
  const changes: string[] = [];
  service.changed.connect((_, entrypoint) => changes.push(entrypoint));
  const emit = (data: Record<string, string | null>) =>
    events.stream.emit({ schema_id: JOB_EVENT_SCHEMA, ...data });
  return {
    service,
    changes,
    emit,
    dispose: () => {
      service.dispose();
      events.dispose();
    }
  };
}

beforeEach(() => {
  jest.mocked(listRuns).mockReset();
  jest.mocked(startRun).mockReset();
  jest.mocked(getRun).mockReset();
  jest.mocked(cancelRun).mockReset();
});

it('reads a listing once for concurrent refreshes and keeps old runs on failure', async () => {
  const h = host();
  try {
    jest.mocked(listRuns).mockResolvedValue({ runs: [run()], jobs: [job()] });
    expect(h.service.runs(ENTRYPOINT).loaded).toBe(false);
    const [first, second] = await Promise.all([
      h.service.refresh(ENTRYPOINT),
      h.service.refresh('./proj/astra.yaml')
    ]);
    expect(first).toBe(second);
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(listRuns).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT);
    expect(first.loaded).toBe(true);
    expect(first.runs).toHaveLength(1);
    expect(h.service.runningJobs()).toEqual([
      { entrypoint: ENTRYPOINT, job: job() }
    ]);
    expect(h.changes).toContain(ENTRYPOINT);
    jest.mocked(listRuns).mockRejectedValue(new Error('git is missing'));
    await expect(h.service.refresh(ENTRYPOINT)).rejects.toThrow(
      'git is missing'
    );
    const after = h.service.runs(ENTRYPOINT);
    expect(after.error).toBe('git is missing');
    expect(after.loading).toBe(false);
    expect(after.runs).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it('applies job events, then reads the finished job and the new history', async () => {
  const h = host();
  try {
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [job()] });
    await h.service.refresh(ENTRYPOINT);
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-1');
    h.emit({ id: 'job-1', project: 'proj', state: 'running', line: 'step 1' });
    expect(h.service.runs(ENTRYPOINT).jobs[0].lines).toEqual(['step 1']);
    expect(getRun).not.toHaveBeenCalled();

    const done = job({
      state: 'succeeded',
      exit: 0,
      finished: '2026-09-23T12:00:00.000Z',
      lines: ['step 1', 'done'],
      report: { ok: true, up_to_date: false, made: ['baseline/hubble_diagram'] }
    });
    jest.mocked(getRun).mockResolvedValue(done);
    jest.mocked(listRuns).mockResolvedValue({ runs: [run()], jobs: [done] });
    h.emit({ id: 'job-1', project: 'proj', state: 'succeeded', line: null });
    expect((await finished).state).toBe('succeeded');
    expect(h.service.runningJobs()).toEqual([]);
    await flush();
    expect(getRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, 'job-1');
    expect(listRuns).toHaveBeenCalledTimes(2);
    const state = h.service.runs(ENTRYPOINT);
    expect(state.jobs[0].report).toEqual(done.report);
    expect(state.runs).toHaveLength(1);
    // Already finished: resolves at once.
    expect((await h.service.whenFinished(ENTRYPOINT, 'job-1')).exit).toBe(0);
  } finally {
    h.dispose();
  }
});

it('reads jobs it first hears of through events and ignores other schemas', async () => {
  const h = host();
  try {
    jest.mocked(getRun).mockResolvedValue(job({ id: 'job-9', project: '' }));
    h.emit({ id: 'job-9', project: '', state: 'running', line: 'hello' });
    h.emit({ id: 'job-9', project: '', state: 'running', line: 'again' });
    // Two events, one read: the in-flight request is shared.
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith(
      expect.anything(),
      'astra.yaml',
      'job-9'
    );
    await flush();
    expect(h.service.runningJobs()).toEqual([
      { entrypoint: 'astra.yaml', job: job({ id: 'job-9', project: '' }) }
    ]);
    h.emit({ id: 'job-9', project: '', state: 'running', line: 'later' });
    expect(h.service.runs('astra.yaml').jobs[0].lines).toEqual(['later']);
    // The poll ticks once as soon as a running job appears, then every 5 s.
    await new Promise(resolve => setTimeout(resolve, 60));
    const reads = jest.mocked(getRun).mock.calls.length;
    expect(
      jest
        .mocked(getRun)
        .mock.calls.every(
          call => call[1] === 'astra.yaml' && call[2] === 'job-9'
        )
    ).toBe(true);
    h.emit({ schema_id: 'https://example.org/other', id: 'x', project: '' });
    h.emit({ id: 'job-9', project: '', state: 'wobbly', line: null });
    await flush();
    expect(getRun).toHaveBeenCalledTimes(reads);
    expect(h.service.runs('astra.yaml').jobs[0].state).toBe('running');
    expect(h.service.runs('astra.yaml').jobs[0].lines).toEqual(['later']);
  } finally {
    h.dispose();
  }
});

it('starts and stops jobs through the API', async () => {
  const h = host();
  try {
    jest
      .mocked(startRun)
      .mockResolvedValue(job({ id: 'job-2', targets: ['a'] }));
    const started = await h.service.start('./proj/astra.yaml', {
      targets: ['a'],
      refresh: true
    });
    expect(startRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['a'],
      refresh: true
    });
    expect(h.service.runningJobs().map(item => item.job.id)).toEqual([
      started.id
    ]);
    jest.mocked(cancelRun).mockResolvedValue(undefined);
    jest
      .mocked(getRun)
      .mockResolvedValue(
        job({ id: 'job-2', targets: ['a'], state: 'cancelled' })
      );
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-2');
    await h.service.cancel(ENTRYPOINT, 'job-2');
    expect(cancelRun).toHaveBeenCalledWith(
      expect.anything(),
      ENTRYPOINT,
      'job-2'
    );
    expect((await finished).state).toBe('cancelled');
    expect(h.service.runningJobs()).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('rejects pending waiters and stops listening once disposed', async () => {
  const h = host();
  jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [job()] });
  await h.service.refresh(ENTRYPOINT);
  const waiting = h.service.whenFinished(ENTRYPOINT, 'job-1');
  h.dispose();
  await expect(waiting).rejects.toThrow('disposed');
  h.emit({ id: 'job-1', project: 'proj', state: 'succeeded', line: null });
  await flush();
  expect(getRun).not.toHaveBeenCalled();
  expect(h.service.isDisposed).toBe(true);
});
