import {
  collectCitedDois,
  normalizeDoi,
  type Analysis,
  type Decision,
  type Evidence,
  type Input,
  type Insight,
  type Option,
  type Output,
  type ResolvedAnalysisNode,
  type ResolvedDecision,
  type ResolvedEvidence,
  type ResolvedInput,
  type ResolvedInsight,
  type ResolvedOption,
  type ResolvedOutput
} from '@astra-spec/sdk';
import {
  analysisTitle,
  countLabel,
  recordTitle,
  selectedOptionLabel
} from '@astra-spec/ui/model';
import type { ILoadedProjectData } from './project-data';
import type { InventoryOpenReference } from './open-reference';

export interface IProjectItem {
  kind: string;
  label: string;
  analysisPath: string;
  reference?: InventoryOpenReference;
  /** A decision's option label, resolved while the record itself is in hand. */
  selection?: string;
  fields: Record<string, unknown>;
}

export interface IProjectSnapshot {
  items: Map<string, IProjectItem>;
  /**
   * Output path to server-side content hash. Membership means the artifact
   * exists; an absent hash means the drive does not offer one.
   */
  results: Map<string, string | undefined>;
}

/** Rows outlive the snapshot they came from, so they carry no record payload. */
export interface IProjectChange extends Omit<
  IProjectItem,
  'fields' | 'selection'
> {
  key: string;
  action: 'added' | 'removed' | 'changed' | 'ready' | 'updated';
  detail?: string;
}

/** The keys the resolver adds to a record beyond the authored ones. */
type DerivedKey<Resolved, Authored> = Exclude<keyof Resolved, keyof Authored>;

/** Every key the resolver adds to some record, option, evidence or analysis. */
type ResolverKey =
  | DerivedKey<ResolvedAnalysisNode, Analysis>
  | DerivedKey<ResolvedInput, Input>
  | DerivedKey<ResolvedOutput, Output>
  | DerivedKey<ResolvedDecision, Decision>
  | DerivedKey<ResolvedOption, Option>
  | DerivedKey<ResolvedInsight, Insight>
  | DerivedKey<ResolvedEvidence, Evidence>;

/** Every key an author may write somewhere in `astra.yaml`. */
type AuthoredKey =
  | keyof Analysis
  | keyof Input
  | keyof Output
  | keyof Decision
  | keyof Option
  | keyof Insight
  | keyof Evidence;

/**
 * How change detection treats a resolver key: `strip` removes it by name at
 * every depth, `strip-here` only at a record's top level, `compare` keeps it
 * as part of the record's meaning. A key an author may also write somewhere
 * (`artifact` names a file on an output, a reference on evidence) cannot be
 * stripped at every depth, so the type refuses `strip` for it.
 */
type Treatment<Key extends ResolverKey> = Key extends AuthoredKey
  ? 'strip-here' | 'compare'
  : 'strip' | 'compare';

/**
 * Every resolver key, classified. The SDK exports no runtime list of them,
 * so the record is checked against its types: a key the resolver starts
 * adding fails to compile until it is listed here, and an authored field
 * that later shares a stripped key's name fails at `Treatment`.
 */
const RESOLVER_KEYS: { [Key in ResolverKey]: Treatment<Key> } = {
  canonicalPath: 'strip',
  kind: 'strip',
  provenance: 'strip',
  resolvedFrom: 'strip',
  resolvedInsightPaths: 'strip',
  resolvedOutputPath: 'strip',
  // An output's artifact is runtime metadata; evidence's is a declared
  // reference and stays part of the comparison.
  artifact: 'strip-here',
  // Which option a universe selects, and whether a record is active in it,
  // is the meaning a reader asks about (see `FIELD_LABELS`).
  active: 'compare',
  selectedOptionId: 'compare'
};

function resolverKeys(treatment: Treatment<ResolverKey>): readonly string[] {
  return Object.entries(RESOLVER_KEYS)
    .filter(([, value]) => value === treatment)
    .map(([key]) => key);
}

/** Authored, but not what a reader means by "this record changed". */
const NOISY_AUTHORED_FIELDS = ['created_at'];

/** Matched by name at every depth. */
const IGNORED_FIELDS = new Set([
  ...resolverKeys('strip'),
  ...NOISY_AUTHORED_FIELDS
]);

/** Removed from a record's top level only. */
const TOP_LEVEL_IGNORED_FIELDS = resolverKeys('strip-here');

/** Analysis members that are records in their own right, snapshotted separately. */
const SECTION_FIELDS = new Set([
  'inputs',
  'outputs',
  'decisions',
  'findings',
  'prior_insights',
  'analyses'
]);

function normalize(item: unknown): unknown {
  if (Array.isArray(item)) {
    // Serialise each element once rather than twice per comparison.
    return item
      .map(entry => {
        const value = normalize(entry);
        return [JSON.stringify(value) ?? '', value] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value);
  }
  if (item !== null && typeof item === 'object') {
    return Object.fromEntries(
      Object.entries(item)
        .filter(
          ([key, value]) => !IGNORED_FIELDS.has(key) && value !== undefined
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, normalize(value)])
    );
  }
  return item;
}

/** Compare resolved meaning, ignoring YAML/map/list order and runtime metadata. */
export function semanticValue(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? '';
}

/** Project records and hierarchy, separate from artifact availability. */
export function snapshotProject(data: ILoadedProjectData): IProjectSnapshot {
  const items = new Map<string, IProjectItem>();
  for (const [path, node] of data.index.analysisByPath) {
    items.set(path, {
      kind: path === '$' ? 'project' : 'subanalysis',
      label: analysisTitle(node),
      analysisPath: path,
      fields: Object.fromEntries(
        Object.entries(node).filter(([key]) => !SECTION_FIELDS.has(key))
      )
    });
  }
  for (const [path, record] of data.index.recordByPath) {
    const fields: Record<string, unknown> = { ...record };
    for (const field of TOP_LEVEL_IGNORED_FIELDS) delete fields[field];
    items.set(path, {
      kind: record.kind === 'prior_insight' ? 'insight' : record.kind,
      label: recordTitle(record),
      analysisPath:
        data.index.analysisByRecordPath.get(path)?.canonicalPath ?? '$',
      reference: { kind: record.kind, id: record.id, canonicalPath: path },
      ...(record.kind === 'decision'
        ? { selection: selectedOptionLabel(record) }
        : {}),
      fields
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
      data.bindings.map(binding => [binding.outputPath, undefined])
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

function changeRow(
  item: IProjectItem,
  key: string,
  action: IProjectChange['action'],
  detail?: string
): IProjectChange {
  return {
    key,
    action,
    kind: item.kind,
    label: item.label,
    analysisPath: item.analysisPath,
    ...(item.reference ? { reference: item.reference } : {}),
    ...(detail ? { detail } : {})
  };
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
      changes.push(changeRow(item, key, next ? 'added' : 'removed'));
      continue;
    }
    // This pass also answers "did anything change"; comparing the whole record
    // first would walk the same subtrees a second time.
    const fields = [
      ...new Set([...Object.keys(old.fields), ...Object.keys(next.fields)])
    ].filter(
      field =>
        !IGNORED_FIELDS.has(field) &&
        semanticValue(old.fields[field]) !== semanticValue(next.fields[field])
    );
    if (!fields.length) continue;
    const selection = fields.includes('selectedOptionId')
      ? `${old.selection} → ${next.selection}`
      : undefined;
    // The arrow already names the selection, so its own fields stay out of the list.
    const remaining = fields
      .filter(
        field =>
          !selection || (field !== 'selectedOptionId' && field !== 'default')
      )
      .map(field => FIELD_LABELS[field] ?? field)
      .join(', ');
    changes.push(
      changeRow(
        item,
        key,
        'changed',
        [selection, remaining].filter(Boolean).join('; ')
      )
    );
  }
  for (const [key, hash] of after.results) {
    const item = after.items.get(key);
    if (!item) continue;
    const known = before.results.has(key);
    const previous = before.results.get(key);
    // Without a hash on both sides, a rerun is indistinguishable from a touch.
    if (known && !(previous && hash && previous !== hash)) continue;
    changes.push({
      ...changeRow(item, `result:${key}`, known ? 'updated' : 'ready'),
      kind: 'result'
    });
  }
  return changes;
}

/** A short notification; record-level detail stays behind Review changes. */
export function summarizeChanges(changes: readonly IProjectChange[]): string {
  const results = changes.filter(change => change.kind === 'result').length;
  const edits = changes.length - results;
  return [
    edits ? countLabel(edits, 'project change') : '',
    results ? `${countLabel(results, 'result')} ready` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}
