import type { IComputeListing, IComputeTarget } from '../compute-api';

/** This host, as a workstation's server lists it. */
export function hostTarget(
  overrides: Partial<IComputeTarget> = {}
): IComputeTarget {
  return {
    id: 'host',
    kind: 'host',
    backend: null,
    variant: 'machine',
    state: 'ready',
    active: true,
    other: null,
    problem: null,
    size: { threads: 16, nodes: null, workers: null },
    ...overrides
  };
}

/** A four-node Slurm cluster, running and busy. */
export function slurmTarget(
  overrides: Partial<IComputeTarget> = {}
): IComputeTarget {
  return {
    id: '20260924-141502-k3x9',
    kind: 'cluster',
    backend: 'slurm',
    label: 'Regular · 4 nodes · 2 h',
    state: 'running',
    active: true,
    other: null,
    problem: null,
    size: { threads: 512, nodes: 4, workers: 4 },
    load: { workers: 4, threads: 512, busy: 384 },
    timeLeft: 6125,
    startEstimate: null,
    dashboard: '/user/me/proxy/nid001:8787/status',
    details: ['Job 31415926', 'regular', 'm1234'],
    created: '2026-09-24T14:15:02Z',
    ...overrides
  };
}

export function listing(
  targets: IComputeTarget[],
  overrides: Partial<IComputeListing> = {}
): IComputeListing {
  return {
    format: 'lightcone.cluster/1',
    attaches: true,
    lightcone: '0.5.0rc2',
    idleTimeout: 1800,
    backends: ['slurm'],
    targets,
    ended: [],
    ...overrides
  };
}
