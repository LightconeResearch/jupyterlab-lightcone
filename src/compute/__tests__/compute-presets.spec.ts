import { nullTranslator } from '@jupyterlab/translation';
import type { IClusterPreset } from '../compute-api';
import {
  nodeHours,
  offeredPresets,
  parsePresets,
  presetCaption,
  presetMenuLabel,
  slurmHours
} from '../compute-presets';

const trans = nullTranslator.load('jupyterlab_lightcone');

const REGULAR: IClusterPreset = {
  label: 'Regular · 4 nodes · 2 h',
  backend: 'slurm',
  nodes: 4,
  time: '2:00:00',
  qos: 'regular',
  constraint: 'cpu'
};
const DEBUG: IClusterPreset = {
  label: 'Debug · 1 node · 30 min',
  backend: 'slurm',
  nodes: 1,
  time: '30'
};
const MEDIUM: IClusterPreset = {
  label: 'Medium',
  backend: 'gateway',
  workers: 6,
  cores: 2,
  memory: 4
};

test('only well-formed presets are kept, with their known fields', () => {
  expect(
    parsePresets([
      { ...REGULAR, extra: 'ignored' },
      { label: '', backend: 'slurm' },
      { label: 'PBS', backend: 'pbs' },
      { label: 'Local', backend: 'local', threads: 'many' },
      'not a preset'
    ])
  ).toEqual([REGULAR, { label: 'Local', backend: 'local' }]);
  expect(parsePresets(undefined)).toEqual([]);
});

test('offered presets are those of available backends, the last used first', () => {
  const presets = [DEBUG, REGULAR, MEDIUM];
  expect(offeredPresets(presets, ['slurm'], null)).toEqual([DEBUG, REGULAR]);
  expect(offeredPresets(presets, ['slurm'], REGULAR.label)).toEqual([
    REGULAR,
    DEBUG
  ]);
  expect(offeredPresets(presets, ['gateway'], REGULAR.label)).toEqual([MEDIUM]);
});

test.each([
  ['30', 0.5],
  ['2:00:00', 2],
  ['1:30:00', 1.5],
  ['1-00:00:00', 24],
  ['1-12', 36],
  ['45:00', 0.75],
  ['two hours', null]
])('Slurm time %s is %s hours', (time, hours) => {
  expect(slurmHours(time)).toBe(hours);
});

test('a Slurm preset states what it may charge', () => {
  expect(nodeHours(REGULAR)).toBe(8);
  expect(nodeHours(DEBUG)).toBe(0.5);
  expect(nodeHours(MEDIUM)).toBeNull();
  expect(presetMenuLabel(REGULAR, trans)).toBe(
    'Regular · 4 nodes · 2 h · ≈ 8 node-hours'
  );
  expect(presetMenuLabel(DEBUG, trans)).toBe(
    'Debug · 1 node · 30 min · ≈ 0.5 node-hours'
  );
  expect(presetMenuLabel(MEDIUM, trans)).toBe('Medium');
});

test('a preset without a description is described by its size', () => {
  expect(presetCaption(REGULAR, trans)).toBe(
    '4 nodes · 2:00:00 · regular · cpu'
  );
  expect(presetCaption(MEDIUM, trans)).toBe('Adapts up to 6 workers');
  expect(presetCaption({ label: 'L', backend: 'local' }, trans)).toBe(
    'Every core'
  );
  expect(presetCaption({ ...MEDIUM, description: 'For plots' }, trans)).toBe(
    'For plots'
  );
});
