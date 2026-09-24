import { nullTranslator } from '@jupyterlab/translation';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IComputeTarget } from '../compute-api';
import { ComputeSection, type IComputeSectionProps } from '../compute-section';
import { hostTarget, listing, slurmTarget } from './compute-fixtures';

const trans = nullTranslator.load('jupyterlab_lightcone');
const BASE = 'jp-jupyterlab-lightcone-Compute';

let actEnvironment: unknown;
beforeAll(() => {
  actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
});

let mounted: Root[] = [];
afterEach(() => {
  mounted.forEach(root => act(() => root.unmount()));
  mounted = [];
});

function render(props: Partial<IComputeSectionProps>) {
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push(root);
  const handlers = {
    onNew: jest.fn(),
    onActions: jest.fn(),
    onReplace: jest.fn()
  };
  act(() =>
    root.render(
      <ComputeSection
        listing={null}
        error={null}
        pending={false}
        trans={trans}
        canCreate={false}
        canReplace={() => false}
        {...handlers}
        {...props}
      />
    )
  );
  const rows = () =>
    Array.from(node.querySelectorAll(`.${BASE}-target`)).map(row => ({
      name: row.querySelector(`.${BASE}-name`)?.textContent,
      meta: row.querySelector(`.${BASE}-meta`)?.textContent,
      active: row.classList.contains('jp-mod-active'),
      detail: row.querySelector(`.${BASE}-detail`)?.textContent ?? null
    }));
  return { node, rows, ...handlers };
}

test('a workstation lists itself, and offers nothing without presets', () => {
  const { node, rows } = render({
    listing: listing([hostTarget()], { backends: ['local'] })
  });
  expect(rows()).toEqual([
    { name: 'This machine', meta: '16 cores', active: true, detail: null }
  ]);
  expect(node.querySelector(`.${BASE}-new`)).toBeNull();
});

test('the active cluster carries its load on a second line', () => {
  const { node, rows } = render({
    listing: listing([
      hostTarget({ variant: 'login', state: 'check-only', active: false }),
      slurmTarget()
    ]),
    canCreate: true
  });
  expect(rows()).toEqual([
    { name: 'Login node', meta: 'check only', active: false, detail: null },
    {
      name: 'Slurm cluster',
      meta: '4 nodes · 1 h 42 min left',
      active: true,
      detail: '384 of 512 threads busy'
    }
  ]);
  const meter = node.querySelector(`.${BASE}-meter`);
  expect(meter?.getAttribute('aria-valuenow')).toBe('384');
  expect(node.querySelector('[aria-current="true"]')?.textContent).toContain(
    'Slurm cluster'
  );
  expect(node.querySelector(`.${BASE}-new`)?.textContent).toBe('New cluster');
});

test('a queued cluster says when it should start', () => {
  const today = new Date();
  const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  const estimate = `${local.toISOString().slice(0, 10)}T14:05:00`;
  const { rows } = render({
    listing: listing([
      hostTarget({ active: false }),
      slurmTarget({
        state: 'queued',
        load: null,
        timeLeft: null,
        startEstimate: estimate
      })
    ])
  });
  expect(rows()[1].detail).toBe('Likely start 14:05');
});

test('a running cluster without telemetry states that its load is unavailable', () => {
  const { node, rows } = render({
    listing: listing([
      hostTarget({ active: false }),
      slurmTarget({
        backend: 'gateway',
        load: null,
        timeLeft: null,
        size: { threads: null, nodes: null, workers: null, maxWorkers: 6 }
      })
    ])
  });
  expect(rows()[1]).toMatchObject({
    meta: 'Up to 6 workers',
    detail: 'Load unavailable'
  });
  expect(node.querySelector('[role="meter"]')).toBeNull();
});

test('a problem is stated, with its one fix when there is one', () => {
  const problem = {
    code: 'version',
    message: 'Workers run lightcone-cli 0.4.0; this server has 0.5.0rc2.'
  };
  const target = slurmTarget({ problem });
  const { node, rows, onReplace } = render({
    listing: listing([hostTarget({ active: false }), target]),
    canReplace: () => true
  });
  expect(rows()[1].detail).toContain('0.4.0');
  const fix = node.querySelector<HTMLButtonElement>(`.${BASE}-fix`);
  expect(fix?.textContent).toBe('Replace');
  act(() => fix?.click());
  expect(onReplace).toHaveBeenCalledWith(target);
  expect(
    node.querySelector(`.${BASE}-dot[data-state="attention"]`)?.textContent
  ).toBe('!');
});

test('only clusters have actions, and the button anchors their menu', () => {
  const cluster = slurmTarget();
  const { node, onActions } = render({
    listing: listing([hostTarget({ active: false }), cluster])
  });
  const buttons = node.querySelectorAll<HTMLButtonElement>(`.${BASE}-more`);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].getAttribute('aria-label')).toBe(
    `Actions for ${cluster.label}`
  );
  act(() => buttons[0].click());
  expect(onActions).toHaveBeenCalledWith(cluster, buttons[0]);
});

test('clusters another host or image serves are listed, muted', () => {
  const { node, rows } = render({
    listing: listing([
      hostTarget(),
      slurmTarget({ active: false, backend: 'gateway', other: 'another image' })
    ])
  });
  expect(rows()[1]).toMatchObject({
    name: 'Gateway cluster',
    meta: 'another image',
    active: false
  });
  expect(node.querySelector('.jp-mod-other')).not.toBeNull();
});

test('an engine that cannot attach says runs stay on this host', () => {
  const { node } = render({
    listing: listing(
      [hostTarget(), slurmTarget({ active: false } as Partial<IComputeTarget>)],
      { attaches: false }
    )
  });
  expect(node.querySelector(`.${BASE}-note`)?.textContent).toBe(
    'lightcone-cli 0.5.0rc2 does not run on clusters yet, so runs stay on this host.'
  );
});

test('before the first listing, and after a failure', () => {
  expect(render({}).node.textContent).toBe('Looking for compute…');
  const failed = render({ error: 'Compute request failed (500): boom' });
  expect(failed.node.querySelector('[role="alert"]')?.textContent).toContain(
    'boom'
  );
});
