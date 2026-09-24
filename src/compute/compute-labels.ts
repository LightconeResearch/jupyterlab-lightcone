import type { TranslationBundle } from '@jupyterlab/translation';
import type { IComputeListing, IComputeTarget } from './compute-api';

/** How a target's dot is drawn. */
export type DotState =
  'ok' | 'busy' | 'waiting' | 'starting' | 'warn' | 'attention' | 'idle';

/** The row's name: the host's kind, or the cluster's backend. */
export function targetName(
  target: IComputeTarget,
  trans: TranslationBundle
): string {
  if (target.kind === 'host') {
    switch (target.variant) {
      case 'server':
        return trans.__('This server');
      case 'login':
        return trans.__('Login node');
      case 'allocation':
        return trans.__('This allocation');
      default:
        return trans.__('This machine');
    }
  }
  switch (target.backend) {
    case 'slurm':
      return trans.__('Slurm cluster');
    case 'gateway':
      return trans.__('Gateway cluster');
    default:
      return trans.__('Local cluster');
  }
}

/** A duration in words: `1 h 42 min`, `35 min`, `2 d 3 h`. */
export function duration(seconds: number, trans: TranslationBundle): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return trans.__('%1 d %2 h', days, hours % 24);
  }
  if (hours > 0) {
    return trans.__('%1 h %2 min', hours, minutes % 60);
  }
  return trans.__('%1 min', Math.max(minutes, 0));
}

/** The size of a target in a few words: cores, nodes, workers or threads. */
function sizeText(target: IComputeTarget, trans: TranslationBundle): string {
  const { size, load } = target;
  if (target.kind === 'host') {
    return size.nodes
      ? trans._n('%1 node', '%1 nodes', size.nodes)
      : trans._n('%1 core', '%1 cores', size.threads ?? 1);
  }
  switch (target.backend) {
    case 'slurm':
      return trans._n('%1 node', '%1 nodes', size.nodes ?? 1);
    case 'gateway': {
      const workers = load?.workers ?? size.workers;
      return workers !== null
        ? trans._n('%1 worker', '%1 workers', workers)
        : size.maxWorkers !== undefined
          ? trans._n('Up to %1 worker', 'Up to %1 workers', size.maxWorkers)
          : trans.__('Worker count unavailable');
    }
    default:
      return trans._n('%1 thread', '%1 threads', size.threads ?? 1);
  }
}

/** The short text at the end of a row. */
export function targetMeta(
  target: IComputeTarget,
  trans: TranslationBundle
): string {
  if (target.other) {
    return target.other;
  }
  switch (target.state) {
    case 'check-only':
      return trans.__('check only');
    case 'queued':
      return trans.__('queued');
    case 'starting':
      return trans.__('starting');
    case 'stopping':
      return trans.__('stopping');
    case 'unknown':
      return trans.__('no answer');
    default:
      return target.timeLeft
        ? trans.__(
            '%1 · %2 left',
            sizeText(target, trans),
            duration(target.timeLeft, trans)
          )
        : sizeText(target, trans);
  }
}

/** When a queued cluster should start, as the scheduler estimates it. */
export function startText(
  estimate: string,
  trans: TranslationBundle,
  today = new Date()
): string {
  const time = estimate.slice(11, 16);
  const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  const sameDay = estimate.slice(0, 10) === local.toISOString().slice(0, 10);
  return sameDay
    ? trans.__('Likely start %1', time)
    : trans.__('Likely start %1 %2', estimate.slice(5, 10), time);
}

export function dotState(target: IComputeTarget): DotState {
  if (target.problem) {
    return target.state === 'check-only' ? 'warn' : 'attention';
  }
  switch (target.state) {
    case 'ready':
      return 'ok';
    case 'running':
      return target.load?.busy ? 'busy' : 'ok';
    case 'queued':
      return 'waiting';
    case 'starting':
      return 'starting';
    case 'check-only':
      return 'warn';
    default:
      return 'idle';
  }
}

/** The text beside the section title, about wherever runs go now. */
export function computeCount(
  listing: IComputeListing | null,
  trans: TranslationBundle
): string {
  const active = listing?.targets.find(target => target.active);
  if (!active) {
    return '';
  }
  if (active.problem) {
    return '!';
  }
  switch (active.state) {
    case 'queued':
      return trans.__('Queued');
    case 'starting':
      return trans.__('Starting');
    case 'check-only':
      return trans.__('Check only');
    default:
      return sizeText(active, trans);
  }
}
