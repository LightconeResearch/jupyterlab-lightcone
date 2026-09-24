import type { TranslationBundle } from '@jupyterlab/translation';
import { isRecord } from '../api';
import { type IClusterPreset, isBackend } from './compute-api';

const NUMBER_FIELDS = [
  'threads',
  'nodes',
  'workers',
  'cores',
  'memory'
] as const;
const TEXT_FIELDS = [
  'description',
  'time',
  'qos',
  'constraint',
  'account'
] as const;

/**
 * The presets in the Compute settings, keeping only well-formed ones.
 * The settings schema already validates them; this also guards against
 * values that reach the plugin some other way.
 */
export function parsePresets(value: unknown): IClusterPreset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const presets: IClusterPreset[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      !isBackend(item.backend)
    ) {
      continue;
    }
    const preset: IClusterPreset = {
      label: item.label.trim(),
      backend: item.backend
    };
    for (const field of NUMBER_FIELDS) {
      const number = item[field];
      if (typeof number === 'number' && Number.isFinite(number)) {
        preset[field] = number;
      }
    }
    for (const field of TEXT_FIELDS) {
      const text = item[field];
      if (typeof text === 'string' && text) {
        preset[field] = text;
      }
    }
    presets.push(preset);
  }
  return presets;
}

/** The presets this server can start, the one used last first. */
export function offeredPresets(
  presets: readonly IClusterPreset[],
  backends: readonly string[],
  lastUsed: string | null
): IClusterPreset[] {
  const offered = presets.filter(preset => backends.includes(preset.backend));
  const last = offered.findIndex(preset => preset.label === lastUsed);
  return last > 0
    ? [offered[last], ...offered.slice(0, last), ...offered.slice(last + 1)]
    : offered;
}

/** A Slurm time limit (`30`, `2:00:00`, `1-00:00:00`) in hours; null if unreadable. */
export function slurmHours(time: string): number | null {
  const match = /^(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?$/.exec(time.trim());
  if (!match) {
    return null;
  }
  const [, days, first, second, third] = match;
  const n = (text: string | undefined) => (text ? Number(text) : 0);
  let hours: number;
  if (days !== undefined) {
    hours = n(days) * 24 + n(first) + n(second) / 60 + n(third) / 3600;
  } else if (third !== undefined) {
    hours = n(first) + n(second) / 60 + n(third) / 3600;
  } else if (second !== undefined) {
    hours = n(first) / 60 + n(second) / 3600;
  } else {
    hours = n(first) / 60;
  }
  return hours;
}

/** What a Slurm preset may charge: nodes times its time limit, in node-hours. */
export function nodeHours(preset: IClusterPreset): number | null {
  if (preset.backend !== 'slurm') {
    return null;
  }
  const hours = slurmHours(preset.time ?? '1:00:00');
  return hours === null ? null : (preset.nodes ?? 1) * hours;
}

/** The menu line for a preset: its label, with the cost where there is one. */
export function presetMenuLabel(
  preset: IClusterPreset,
  trans: TranslationBundle
): string {
  const cost = nodeHours(preset);
  return cost === null
    ? preset.label
    : trans.__('%1 · ≈ %2 node-hours', preset.label, formatNumber(cost));
}

/** A preset's size in words, for its tooltip when it has no description. */
export function presetCaption(
  preset: IClusterPreset,
  trans: TranslationBundle
): string {
  if (preset.description) {
    return preset.description;
  }
  switch (preset.backend) {
    case 'slurm':
      return [
        trans._n('%1 node', '%1 nodes', preset.nodes ?? 1),
        preset.time ?? '1:00:00',
        preset.qos,
        preset.constraint
      ]
        .filter(Boolean)
        .join(' · ');
    case 'gateway':
      return trans._n(
        'Adapts up to %1 worker',
        'Adapts up to %1 workers',
        preset.workers ?? 2
      );
    default:
      return preset.threads
        ? trans._n('%1 thread', '%1 threads', preset.threads)
        : trans.__('Every core');
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
