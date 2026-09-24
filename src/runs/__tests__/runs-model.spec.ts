import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import type { IJob } from '../runs-api';
import {
  applyJobEvent,
  describeTargets,
  entrypointForProject,
  formatRelativeTime,
  jobOutcome,
  mergeJob,
  refusalText,
  rematerializeAction,
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

describe('time formatting', () => {
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
});

describe('targets', () => {
  it('describes targets', () => {
    expect(describeTargets(['baseline/x'])).toBe('baseline/x');
    expect(describeTargets([])).toBe('everything');
    expect(describeTargets(['a', 'b', 'c', 'd'])).toBe('a, b, c and 1 more');
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

  it('offers to remake stale outputs first, then to refresh those behind', () => {
    expect(
      rematerializeAction({
        'a/x': { state: 'stale', detail: '' },
        'a/y': { state: 'behind', detail: '' }
      })
    ).toEqual({
      kind: 'stale',
      targets: ['a/x'],
      refresh: false,
      label: 'Rematerialize stale (1)'
    });
    expect(
      rematerializeAction({
        'a/y': { state: 'behind', detail: '' },
        'a/z': { state: 'behind', detail: '' }
      })
    ).toEqual({
      kind: 'behind',
      targets: ['a/y', 'a/z'],
      refresh: true,
      label: 'Refresh behind (2)'
    });
    expect(
      rematerializeAction({ 'a/z': { state: 'current', detail: '' } })
    ).toBeNull();
    expect(rematerializeAction(undefined)).toBeNull();
  });

  it('maps job events back to entrypoints', () => {
    expect(entrypointForProject('')).toBe('astra.yaml');
    expect(entrypointForProject('work/proj')).toBe('work/proj/astra.yaml');
    expect(entrypointForProject('drive:')).toBe('drive:astra.yaml');
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
