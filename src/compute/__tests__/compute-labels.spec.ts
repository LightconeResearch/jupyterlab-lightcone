import { nullTranslator } from '@jupyterlab/translation';
import {
  computeCount,
  dotState,
  duration,
  startText,
  targetMeta,
  targetName
} from '../compute-labels';
import { hostTarget, listing, slurmTarget } from './compute-fixtures';

const trans = nullTranslator.load('jupyterlab_lightcone');

test('the host is named by where the server runs', () => {
  expect(targetName(hostTarget(), trans)).toBe('This machine');
  expect(targetName(hostTarget({ variant: 'server' }), trans)).toBe(
    'This server'
  );
  expect(targetName(hostTarget({ variant: 'login' }), trans)).toBe(
    'Login node'
  );
  expect(targetName(hostTarget({ variant: 'allocation' }), trans)).toBe(
    'This allocation'
  );
  expect(targetName(slurmTarget(), trans)).toBe('Slurm cluster');
  expect(targetName(slurmTarget({ backend: 'gateway' }), trans)).toBe(
    'Gateway cluster'
  );
});

test('a row ends with its size, its time left, or what it is waiting for', () => {
  expect(targetMeta(hostTarget(), trans)).toBe('16 cores');
  expect(
    targetMeta(
      hostTarget({
        variant: 'allocation',
        size: { threads: 128, nodes: 2, workers: null }
      }),
      trans
    )
  ).toBe('2 nodes');
  expect(targetMeta(hostTarget({ state: 'check-only' }), trans)).toBe(
    'check only'
  );
  expect(targetMeta(slurmTarget(), trans)).toBe('4 nodes · 1 h 42 min left');
  expect(targetMeta(slurmTarget({ state: 'queued' }), trans)).toBe('queued');
  expect(targetMeta(slurmTarget({ other: 'another image' }), trans)).toBe(
    'another image'
  );
  expect(
    targetMeta(
      slurmTarget({
        backend: 'gateway',
        timeLeft: null,
        load: null,
        size: { threads: null, nodes: null, workers: 6 }
      }),
      trans
    )
  ).toBe('6 workers');
  expect(
    targetMeta(
      slurmTarget({
        backend: 'local',
        timeLeft: null,
        size: { threads: 8, nodes: null, workers: 1 }
      }),
      trans
    )
  ).toBe('8 threads');
});

test('durations read as days, hours or minutes', () => {
  expect(duration(6125, trans)).toBe('1 h 42 min');
  expect(duration(2100, trans)).toBe('35 min');
  expect(duration(183600, trans)).toBe('2 d 3 h');
});

test('a start estimate names the day only when it is not today', () => {
  const today = new Date(2026, 8, 24, 12, 0);
  expect(startText('2026-09-24T14:05:00', trans, today)).toBe(
    'Likely start 14:05'
  );
  expect(startText('2026-09-25T09:00:00', trans, today)).toBe(
    'Likely start 09-25 09:00'
  );
});

test('dots follow state and problems', () => {
  expect(dotState(hostTarget())).toBe('ok');
  expect(dotState(slurmTarget())).toBe('busy');
  expect(
    dotState(slurmTarget({ load: { workers: 4, threads: 512, busy: 0 } }))
  ).toBe('ok');
  expect(dotState(slurmTarget({ state: 'queued' }))).toBe('waiting');
  expect(dotState(slurmTarget({ state: 'starting' }))).toBe('starting');
  expect(dotState(slurmTarget({ state: 'stopping' }))).toBe('idle');
  expect(
    dotState(slurmTarget({ problem: { code: 'version', message: 'old' } }))
  ).toBe('attention');
  expect(
    dotState(
      hostTarget({
        state: 'check-only',
        problem: { code: 'login-node', message: 'x' }
      })
    )
  ).toBe('warn');
});

test('the section title counts wherever runs go now', () => {
  expect(computeCount(null, trans)).toBe('');
  expect(computeCount(listing([hostTarget()]), trans)).toBe('16 cores');
  expect(
    computeCount(listing([hostTarget({ active: false }), slurmTarget()]), trans)
  ).toBe('4 nodes');
  expect(
    computeCount(
      listing([
        hostTarget({ active: false }),
        slurmTarget({ state: 'queued' })
      ]),
      trans
    )
  ).toBe('Queued');
  expect(
    computeCount(
      listing([
        hostTarget({
          state: 'check-only',
          problem: { code: 'login-node', message: 'x' }
        })
      ]),
      trans
    )
  ).toBe('!');
});
