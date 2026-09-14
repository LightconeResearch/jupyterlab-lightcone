import { collectCitedDois, normalizeDoi } from '@astra-spec/sdk';
import type { ILoadedProjectData } from './project-data';
import type { InventoryOpenReference } from './open-reference';

export interface IProjectItem {
  kind: string;
  label: string;
  analysisPath: string;
  reference?: InventoryOpenReference;
  fields: Record<string, unknown>;
}
export interface IProjectSnapshot {
  items: Map<string, IProjectItem>;
  results: Map<string, { token: string; path: string; hash?: string }>;
}
export interface IProjectChange extends IProjectItem {
  key: string;
  action: 'added' | 'removed' | 'changed' | 'ready' | 'updated';
  detail?: string;
}

const DERIVED_FIELDS = new Set([
  'canonicalPath',
  'kind',
  'artifact',
  'provenance',
  'resolvedFrom',
  'resolvedInsightPaths',
  'resolvedOutputPath',
  'created_at'
]);

/** Compare resolved meaning, ignoring YAML/map/list order and runtime metadata. */
export function semanticValue(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item
        .map(normalize)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([key, val]) => !DERIVED_FIELDS.has(key) && val !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, normalize(val)])
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value)) ?? '';
}

/** Project records and hierarchy, separate from artifact availability. */
export function snapshotProject(data: ILoadedProjectData): IProjectSnapshot {
  const items = new Map<string, IProjectItem>();
  for (const [path, node] of data.index.analysisByPath) {
    const sections = new Set([
      'inputs',
      'outputs',
      'decisions',
      'findings',
      'prior_insights',
      'analyses'
    ]);
    const fields = Object.fromEntries(
      Object.entries(node).filter(([key]) => !sections.has(key))
    );
    items.set(path, {
      kind: path === '$' ? 'project' : 'subanalysis',
      label: node.name ?? node.id ?? path,
      analysisPath: path,
      fields
    });
  }
  for (const [path, record] of data.index.recordByPath) {
    items.set(path, {
      kind: record.kind === 'prior_insight' ? 'insight' : record.kind,
      label: record.label ?? record.id,
      analysisPath:
        data.index.analysisByRecordPath.get(path)?.canonicalPath ?? '$',
      reference: { kind: record.kind, id: record.id, canonicalPath: path },
      fields: { ...record }
    });
  }
  for (const source of collectCitedDois(data.document)) {
    const doi = normalizeDoi(source);
    items.set(`paper:${doi}`, {
      kind: 'paper',
      label: doi,
      analysisPath: '$',
      reference: { kind: 'paper', doi },
      fields: { doi }
    });
  }
  return {
    items,
    results: new Map(
      data.bindings.map(binding => [
        binding.outputPath,
        { token: binding.cacheToken, path: binding.path }
      ])
    )
  };
}

const FIELD_LABELS: Record<string, string> = {
  selectedOptionId: 'selection',
  default: 'default option',
  when: 'conditions',
  from: 'source',
  ref: 'reference',
  ref_version: 'reference version',
  use_outputs: 'referenced outputs',
  active: 'availability'
};

function selectedLabel(fields: Record<string, unknown>): string {
  const options = fields.options;
  const option: unknown = Array.isArray(options)
    ? options.find(
        (value: unknown) =>
          value !== null &&
          typeof value === 'object' &&
          'id' in value &&
          value.id === fields.selectedOptionId
      )
    : undefined;
  return option &&
    typeof option === 'object' &&
    'label' in option &&
    typeof option.label === 'string'
    ? option.label
    : String(fields.selectedOptionId ?? 'none');
}

/** Produce one row per changed record; materialization never changes its definition. */
export function diffProjects(
  before: IProjectSnapshot,
  after: IProjectSnapshot
): IProjectChange[] {
  const changes: IProjectChange[] = [];
  for (const key of new Set([...before.items.keys(), ...after.items.keys()])) {
    const old = before.items.get(key);
    const next = after.items.get(key);
    const item = next ?? old!;
    if (!old || !next) {
      changes.push({ ...item, key, action: next ? 'added' : 'removed' });
    } else if (semanticValue(old.fields) !== semanticValue(next.fields)) {
      const fields = [
        ...new Set([...Object.keys(old.fields), ...Object.keys(next.fields)])
      ].filter(
        field =>
          !DERIVED_FIELDS.has(field) &&
          semanticValue(old.fields[field]) !== semanticValue(next.fields[field])
      );
      const selection = fields.includes('selectedOptionId')
        ? `${selectedLabel(old.fields)} → ${selectedLabel(next.fields)}`
        : undefined;
      changes.push({
        ...item,
        key,
        action: 'changed',
        detail: [
          selection,
          fields
            .filter(
              field =>
                !selection || !['selectedOptionId', 'default'].includes(field)
            )
            .map(field => FIELD_LABELS[field] ?? field)
            .join(', ')
        ]
          .filter(Boolean)
          .join('; ')
      });
    }
  }
  for (const [key, result] of after.results) {
    const old = before.results.get(key);
    const item = after.items.get(key);
    if (!item) continue;
    const updated = old?.hash && result.hash && old.hash !== result.hash;
    if (!old || updated) {
      changes.push({
        ...item,
        key: `result:${key}`,
        kind: 'result',
        action: old ? 'updated' : 'ready'
      });
    }
  }
  return changes;
}

/** A short notification; record-level detail stays behind Review changes. */
export function summarizeChanges(changes: readonly IProjectChange[]): string {
  const results = changes.filter(change => change.kind === 'result').length;
  const edits = changes.length - results;
  return [
    edits ? `${edits} project ${edits === 1 ? 'change' : 'changes'}` : '',
    results ? `${results} ${results === 1 ? 'result' : 'results'} ready` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}
