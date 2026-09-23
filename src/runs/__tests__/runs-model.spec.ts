import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import type { IJob, IRunRecord } from '../runs-api';
import {
  applyJobEvent,
  dayLabel,
  describeTargets,
  entrypointForProject,
  formatDuration,
  formatElapsed,
  formatRelativeTime,
  groupRunsByDay,
  jobOutcome,
  jobRunningItems,
  jobTitle,
  lastEndKey,
  mergeJob,
  parseTargets,
  refusalText,
  staleTargets,
  startErrorMessage,
  summarizeReport,
  upsertJob,
  JOB_LINE_LIMIT
} from '../runs-model';

const NOW_ISO = '2026-09-23T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);

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
    inputs: ['data/union.csv'],
    outputs: ['results/baseline/hubble_diagram.png'],
    ...overrides
  };
}

describe('time formatting', () => {
  it('formats durations in the largest useful unit', () => {
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(184_000)).toBe('3 min 4 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
    expect(formatDuration(-5)).toBe('0 s');
  });

  it('measures elapsed time to now for running jobs and to the end otherwise', () => {
    expect(formatElapsed(job(), NOW)).toBe('1 min 30 s');
    expect(
      formatElapsed(job({ finished: '2026-09-23T11:59:00.000Z' }), NOW)
    ).toBe('30 s');
    expect(formatElapsed(job({ started: 'nonsense' }), NOW)).toBe('');
  });

  it('describes relative times', () => {
    expect(formatRelativeTime('2026-09-23T11:59:40.000Z', NOW)).toBe(
      'just now'
    );
    expect(formatRelativeTime('2026-09-23T11:55:00.000Z', NOW)).toBe(
      '5 min ago'
    );
    expect(formatRelativeTime('2026-09-23T09:00:00.000Z', NOW)).toBe(
      '3 hours ago'
    );
    expect(formatRelativeTime('2026-09-22T11:00:00.000Z', NOW)).toBe(
      'yesterday'
    );
    expect(formatRelativeTime('2026-09-13T12:00:00.000Z', NOW)).toBe(
      '10 days ago'
    );
    expect(formatRelativeTime('2026-06-23T12:00:00.000Z', NOW)).toBe(
      '3 months ago'
    );
    expect(formatRelativeTime('not a date', NOW)).toBe('not a date');
  });

  it('labels today and yesterday and groups consecutive runs by day', () => {
    // Days are the viewer's, so the fixtures are local times: the labels
    // must not depend on the zone the tests run in.
    const at = (day: number, hour: number) =>
      new Date(2026, 8, day, hour).toISOString();
    const noon = new Date(2026, 8, 23, 12).getTime();
    expect(dayLabel(at(23, 0), noon)).toBe('Today');
    expect(dayLabel(at(22, 23), noon)).toBe('Yesterday');
    expect(dayLabel(at(1, 11), noon)).not.toMatch(/Today|Yesterday/);
    const groups = groupRunsByDay(
      [
        run({ commit: '1', time: at(23, 11) }),
        run({ commit: '2', time: at(23, 0) }),
        run({ commit: '3', time: at(22, 23) })
      ],
      noon
    );
    expect(groups.map(group => [group.label, group.runs.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1]
    ]);
  });
});

describe('job titles and targets', () => {
  it('names jobs by verb and targets', () => {
    expect(jobTitle({ targets: [], refresh: false })).toBe(
      'Materialize everything'
    );
    expect(jobTitle({ targets: ['a', 'b'], refresh: true })).toBe(
      'Refresh a, b'
    );
    expect(
      jobTitle({ targets: ['a', 'b', 'c', 'd', 'e'], refresh: false })
    ).toBe('Materialize a, b, c and 2 more');
    expect(describeTargets(['baseline/x'])).toBe('baseline/x');
    expect(describeTargets([])).toBe('everything');
    expect(describeTargets(['a', 'b', 'c', 'd'])).toBe('a, b, c and 1 more');
  });

  it('parses typed targets and refuses what the engine would misread', () => {
    expect(parseTargets('  hubble_diagram, baseline/fit\n fit ')).toEqual({
      targets: ['hubble_diagram', 'baseline/fit', 'fit'],
      invalid: []
    });
    expect(parseTargets('a a --check ../x')).toEqual({
      targets: ['a'],
      invalid: ['--check', '../x']
    });
    expect(parseTargets('')).toEqual({ targets: [], invalid: [] });
  });
});

describe('job updates', () => {
  it('appends event lines within the cap and marks the end once', () => {
    const running = applyJobEvent(
      job(),
      { id: 'job-1', project: 'proj', state: 'running', line: 'step 1' },
      NOW
    );
    expect(running.lines).toEqual(['step 1']);
    expect(running.finished).toBeNull();
    const full = applyJobEvent(
      job({ lines: Array.from({ length: JOB_LINE_LIMIT }, (_, i) => `${i}`) }),
      { id: 'job-1', project: 'proj', state: 'running', line: 'last' },
      NOW
    );
    expect(full.lines).toHaveLength(JOB_LINE_LIMIT);
    expect(full.lines[full.lines.length - 1]).toBe('last');
    expect(full.lines[0]).toBe('1');
    const done = applyJobEvent(
      running,
      { id: 'job-1', project: 'proj', state: 'succeeded', line: null },
      NOW
    );
    expect(done.state).toBe('succeeded');
    expect(done.finished).toBe(new Date(NOW).toISOString());
    // A late "running" event never revives a finished job.
    const late = applyJobEvent(
      done,
      { id: 'job-1', project: 'proj', state: 'running', line: 'echo' },
      NOW
    );
    expect(late.state).toBe('succeeded');
    expect(late.lines).toEqual(['step 1', 'echo']);
  });

  it('merges snapshots without moving a job backwards', () => {
    const local = job({ state: 'succeeded', lines: ['a', 'b'], finished: 'x' });
    const stale = job({ state: 'running', lines: ['a'] });
    expect(mergeJob(local, stale)).toEqual(local);
    const server = job({
      state: 'succeeded',
      lines: ['a'],
      exit: 0,
      finished: 'y',
      report: { ok: true }
    });
    const merged = mergeJob(job({ lines: ['a', 'b', 'c'] }), server);
    expect(merged.state).toBe('succeeded');
    expect(merged.lines).toEqual(['a', 'b', 'c']);
    expect(merged.exit).toBe(0);
    expect(merged.report).toEqual({ ok: true });
  });

  it('upserts jobs newest first within the list cap', () => {
    const older = job({ id: 'old', started: '2026-09-23T10:00:00.000Z' });
    const jobs = upsertJob([older], job({ id: 'new' }));
    expect(jobs.map(item => item.id)).toEqual(['new', 'old']);
    const replaced = upsertJob(jobs, { ...older, state: 'failed' });
    expect(replaced.map(item => [item.id, item.state])).toEqual([
      ['new', 'running'],
      ['old', 'failed']
    ]);
    const many = Array.from({ length: 25 }, (_, i) =>
      job({
        id: `j${i}`,
        started: `2026-09-23T10:${String(i).padStart(2, '0')}:00.000Z`
      })
    );
    expect(many.reduce(upsertJob, [] as IJob[])).toHaveLength(20);
  });

  it('keys the last end so it changes even when the list is full', () => {
    const ended = (i: number, finished: string | null = 'done') =>
      job({
        id: `j${i}`,
        state: 'succeeded',
        finished,
        started: `2026-09-23T10:${String(i).padStart(2, '0')}:00.000Z`
      });
    const full = Array.from({ length: 20 }, (_, i) => ended(i)).reduce(
      upsertJob,
      [] as IJob[]
    );
    expect(lastEndKey(full)).toBe('j19:done');
    // A job first seen already ended replaces the oldest: the list keeps
    // its length and number of finished jobs, but the key moves.
    const next = upsertJob(full, ended(20));
    expect(next.filter(item => item.state !== 'running')).toHaveLength(20);
    expect(lastEndKey(next)).toBe('j20:done');
    // A running job has not ended; its end, then its final record, move it.
    const started = upsertJob(next, job({ id: 'j21', started: NOW_ISO }));
    expect(lastEndKey(started)).toBe('j20:done');
    const stopped = upsertJob(started, {
      ...started[0],
      state: 'cancelled'
    });
    expect(lastEndKey(stopped)).toBe('j21:');
    expect(
      lastEndKey(upsertJob(stopped, { ...stopped[0], finished: 'later' }))
    ).toBe('j21:later');
    expect(lastEndKey([job()])).toBe('');
  });
});

describe('reports and outcomes', () => {
  const report = {
    ok: false,
    up_to_date: false,
    made: ['baseline/hubble_diagram'],
    current: ['baseline/fit'],
    behind: { 'baseline/contours': 'made under env 3, now 4' },
    failed: ['baseline/table'],
    blocked: ['baseline/summary'],
    planned: {},
    warnings: ['lock scan found nothing'],
    notes: [],
    extra: 'ignored'
  };

  it('validates the engine report and ignores unknown fields', () => {
    expect(summarizeReport(report)).toEqual({
      ok: false,
      upToDate: false,
      made: ['baseline/hubble_diagram'],
      current: ['baseline/fit'],
      behind: [{ key: 'baseline/contours', why: 'made under env 3, now 4' }],
      failed: ['baseline/table'],
      blocked: ['baseline/summary'],
      planned: [],
      warnings: ['lock scan found nothing'],
      notes: []
    });
    expect(summarizeReport(null)).toBeNull();
    expect(summarizeReport({ made: ['x'] })).toBeNull();
    expect(summarizeReport({ ok: true, made: 'x', behind: [1] })).toEqual(
      expect.objectContaining({ ok: true, made: [], behind: [] })
    );
  });

  it('surfaces the engine refusal only for failures without a report', () => {
    const refused = job({
      state: 'failed',
      exit: 1,
      lines: ['', 'the tree is dirty:', '  M src/plot.py']
    });
    expect(refusalText(refused)).toBe('the tree is dirty:\n  M src/plot.py');
    expect(refusalText(job({ state: 'failed', exit: 2 }))).toBe(
      'The engine exited with code 2 without a report.'
    );
    expect(refusalText(job({ state: 'failed', report }))).toBeNull();
    expect(refusalText(job({ state: 'succeeded' }))).toBeNull();
    expect(jobOutcome(refused)).toBe('the tree is dirty:');
  });

  it('describes how a job ended', () => {
    expect(jobOutcome(job())).toBe('Materializing…');
    expect(jobOutcome(job({ state: 'cancelled' }))).toBe(
      'Materialization stopped.'
    );
    expect(
      jobOutcome(
        job({ state: 'succeeded', report: { ...report, ok: true, failed: [] } })
      )
    ).toBe('Materialized 1 output: baseline/hubble_diagram');
    expect(
      jobOutcome(
        job({ state: 'succeeded', report: { ok: true, up_to_date: true } })
      )
    ).toBe('Everything is already current.');
    expect(jobOutcome(job({ state: 'failed', report }))).toBe(
      '1 output failed: baseline/table'
    );
    expect(
      jobOutcome(job({ state: 'failed', exit: 3, report: { ok: false } }))
    ).toBe('Materialization failed with exit code 3.');
  });
});

describe('helpers for other views', () => {
  it('lists stale and behind outputs as engine targets', () => {
    expect(
      staleTargets({
        'b/x': { state: 'stale', detail: '' },
        'a/y': { state: 'behind', detail: '' },
        'a/x': { state: 'stale', detail: '' },
        'a/z': { state: 'current', detail: '' }
      })
    ).toEqual({ stale: ['a/x', 'b/x'], behind: ['a/y'] });
    expect(staleTargets(undefined)).toEqual({ stale: [], behind: [] });
  });

  it('maps job events back to entrypoints', () => {
    expect(entrypointForProject('')).toBe('astra.yaml');
    expect(entrypointForProject('work/proj')).toBe('work/proj/astra.yaml');
    expect(entrypointForProject('drive:')).toBe('drive:astra.yaml');
  });

  it('builds Running panel items for running jobs', () => {
    const open = jest.fn();
    const stop = jest.fn();
    const items = jobRunningItems(
      [
        { entrypoint: 'proj/astra.yaml', job: job({ targets: ['a'] }) },
        { entrypoint: 'astra.yaml', job: job({ id: 'job-2', refresh: true }) }
      ],
      { open, stop }
    );
    expect(items.map(item => item.label())).toEqual([
      'Materialize a',
      'Refresh everything'
    ]);
    expect(items[0].labelTitle()).toBe('Materialize a · proj');
    expect(items[1].labelTitle()).toBe('Refresh everything · /');
    expect(items[0].context).toBe('proj/astra.yaml');
    items[0].open();
    expect(open).toHaveBeenCalledWith('proj/astra.yaml');
    items[1].shutdown();
    expect(stop).toHaveBeenCalledWith('astra.yaml', 'job-2');
  });

  it('explains why a job could not start', () => {
    const conflict = new RequestError(
      'Runs',
      new ServerConnection.ResponseError(new Response('', { status: 409 }))
    );
    expect(startErrorMessage(conflict)).toMatch(/already running/);
    expect(startErrorMessage(new Error('offline'))).toBe('offline');
    expect(startErrorMessage('odd')).toBe('odd');
  });
});
