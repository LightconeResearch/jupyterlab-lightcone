import { cancelRun, getRun, listRuns, startRun } from '../runs-api';
import { jobOutcome, refusalText } from '../runs-model';
import { FORGOTTEN_JOB_MESSAGE } from '../runs-service';
import { flush, job, refused, run, runsHost as host } from './runs-fixtures';

jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

const ENTRYPOINT = 'proj/astra.yaml';

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
    // The event has no exit code or report: the job ends with its record.
    expect(h.service.runs(ENTRYPOINT).jobs[0].state).toBe('running');
    expect(await finished).toEqual(done);
    expect(jobOutcome(await finished)).toBe(
      'Materialized 1 output: baseline/hubble_diagram'
    );
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

it('ends a failed job with its report, never as a refusal', async () => {
  const h = host();
  try {
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [job()] });
    await h.service.refresh(ENTRYPOINT);
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-1');
    const report = { ok: false, failed: ['baseline/table'] };
    const lines = ['materializing baseline/table', JSON.stringify(report)];
    const failed = job({
      state: 'failed',
      exit: 1,
      finished: '2026-09-23T12:00:00.000Z',
      lines,
      report
    });
    jest.mocked(getRun).mockResolvedValue(failed);
    const seen: string[] = [];
    h.service.changed.connect(() => {
      const current = h.service.runs(ENTRYPOINT).jobs[0];
      if (refusalText(current) !== null) {
        seen.push(current.state);
      }
    });
    for (const line of lines) {
      h.emit({ id: 'job-1', project: 'proj', state: 'running', line });
    }
    h.emit({ id: 'job-1', project: 'proj', state: 'failed', line: null });
    const outcome = await finished;
    expect(outcome.report).toEqual(report);
    expect(jobOutcome(outcome)).toBe('1 output failed: baseline/table');
    // The job never looked like a refusal on its way to its record.
    expect(seen).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('ends a job from its event alone when its record cannot be read', async () => {
  const h = host();
  try {
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [job()] });
    await h.service.refresh(ENTRYPOINT);
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-1');
    jest.mocked(getRun).mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    h.emit({ id: 'job-1', project: 'proj', state: 'cancelled', line: null });
    const outcome = await finished;
    expect(outcome.state).toBe('cancelled');
    expect(outcome.finished).not.toBeNull();
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  } finally {
    h.dispose();
  }
});

it('reads the history when the first event it hears of a job is its end', async () => {
  const h = host();
  try {
    const done = job({ id: 'job-7', state: 'succeeded', exit: 0 });
    jest.mocked(getRun).mockResolvedValue(done);
    jest.mocked(listRuns).mockResolvedValue({ runs: [run()], jobs: [done] });
    h.emit({ id: 'job-7', project: 'proj', state: 'succeeded', line: null });
    await flush();
    await flush();
    expect(getRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, 'job-7');
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(h.service.runs(ENTRYPOINT).runs).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it('forgets a running job the server no longer knows', async () => {
  const h = host();
  try {
    // The server restarted after this listing: it knows no job any more.
    jest
      .mocked(listRuns)
      .mockResolvedValueOnce({ runs: [], jobs: [job()] })
      .mockResolvedValue({ runs: [run()], jobs: [] });
    jest.mocked(getRun).mockRejectedValue(refused(404));
    await h.service.refresh(ENTRYPOINT);
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-1');
    // The poll's first read, as soon as the running job appears, is a 404.
    await expect(finished).rejects.toThrow(FORGOTTEN_JOB_MESSAGE);
    expect(h.service.runs(ENTRYPOINT).jobs).toEqual([]);
    expect(h.service.runningJobs()).toEqual([]);
    await flush();
    expect(listRuns).toHaveBeenCalledTimes(2);
    expect(h.service.runs(ENTRYPOINT).runs).toHaveLength(1);
    const reads = jest.mocked(getRun).mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(getRun).toHaveBeenCalledTimes(reads);
  } finally {
    h.dispose();
  }
});

it('drops a job it is asked to stop that the server no longer knows', async () => {
  const h = host();
  try {
    jest.mocked(startRun).mockResolvedValue(job({ id: 'job-3' }));
    jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
    await h.service.start(ENTRYPOINT);
    const finished = h.service.whenFinished(ENTRYPOINT, 'job-3');
    jest.mocked(cancelRun).mockRejectedValue(refused(404));
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [] });
    await h.service.cancel(ENTRYPOINT, 'job-3');
    await expect(finished).rejects.toThrow(FORGOTTEN_JOB_MESSAGE);
    expect(h.service.runningJobs()).toEqual([]);
    expect(listRuns).toHaveBeenCalledTimes(1);
    jest.mocked(cancelRun).mockRejectedValue(refused(403));
    await expect(h.service.cancel(ENTRYPOINT, 'job-3')).rejects.toThrow('403');
  } finally {
    h.dispose();
  }
});

it('reads the listing when the server says a job already runs', async () => {
  const h = host();
  try {
    const elsewhere = job({ id: 'job-4' });
    jest.mocked(startRun).mockRejectedValue(refused(409));
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [elsewhere] });
    jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
    await expect(h.service.start(ENTRYPOINT)).rejects.toThrow('409');
    await flush();
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(h.service.runningJobs()).toEqual([
      { entrypoint: ENTRYPOINT, job: elsewhere }
    ]);
    jest.mocked(startRun).mockRejectedValue(refused(403));
    await expect(h.service.start(ENTRYPOINT)).rejects.toThrow('403');
    await flush();
    expect(listRuns).toHaveBeenCalledTimes(1);
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
    // One read for the events, one for the poll's first tick.
    expect(reads).toBe(2);
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
