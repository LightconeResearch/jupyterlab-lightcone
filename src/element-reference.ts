import {
  assertProjectPath,
  normalizeDoi,
  type ResolvedRecord,
  type ResolvedAnalysisNode
} from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import {
  collectInventoryPapers,
  type InventoryPaper
} from '@astra-spec/ui/model';
import type { ILoadedProjectData } from './project-data';
import { canonicalRecordPath, parseAstraPath } from './vendor/mystra-path';

export interface IProjectContext {
  entrypoint: string;
  /** null pins defaults; undefined lets a standalone command select initially. */
  universeId?: string | null;
}
export interface IElementReference extends IProjectContext {
  target: string;
  doi?: string;
  focusInsightPath?: string;
}
export interface IResolvedElement {
  analysis: ResolvedAnalysisNode;
  record?: ResolvedRecord;
  paper?: InventoryPaper;
  target: string;
}

/** Validate public command arguments before loading a project. */
export function parseElementReference(
  args: ReadonlyPartialJSONObject
): IElementReference {
  if (
    typeof args.entrypoint !== 'string' ||
    typeof args.target !== 'string' ||
    args.target.length > 1024
  ) {
    throw new Error('An astra.yaml entrypoint and MySTRA target are required.');
  }
  if (
    args.doi !== undefined &&
    (typeof args.doi !== 'string' ||
      !/^10\.\d{4,9}\/\S+$/i.test(normalizeDoi(args.doi)))
  )
    throw new Error('Invalid DOI.');
  if (args.doi && args.target)
    throw new Error('Use a target or a DOI, not both.');
  if (
    args.focusInsightPath !== undefined &&
    (typeof args.focusInsightPath !== 'string' ||
      !canonicalRecordPath(parseAstraPath(args.focusInsightPath)))
  )
    throw new Error('Invalid source insight path.');
  assertProjectPath(args.entrypoint);
  if (!/(^|\/)astra\.yaml$/.test(args.entrypoint))
    throw new Error('Expected an astra.yaml entrypoint.');
  if (
    args.universeId !== undefined &&
    args.universeId !== null &&
    typeof args.universeId !== 'string'
  )
    throw new Error('Invalid universeId.');
  return {
    entrypoint: PathExt.normalize(args.entrypoint),
    target: args.target,
    ...(typeof args.doi === 'string' ? { doi: normalizeDoi(args.doi) } : {}),
    universeId: args.universeId,
    ...(typeof args.focusInsightPath === 'string'
      ? { focusInsightPath: args.focusInsightPath }
      : {})
  };
}

/** Resolve exact rooted paths, including children and inventory scopes. */
export function resolveElement(
  data: ILoadedProjectData,
  target: string
): IResolvedElement {
  const path = parseAstraPath(target);
  const canonical = canonicalRecordPath(path);
  if (canonical) {
    const record = data.index.recordByPath.get(canonical);
    const analysis = data.index.analysisByRecordPath.get(canonical);
    if (!record || !analysis) throw new Error(`TARGET_NOT_FOUND: ${target}`);
    if (path.child) {
      const children =
        record.kind === 'decision'
          ? record.options
          : record.kind === 'finding' || record.kind === 'prior_insight'
            ? record.evidence
            : [];
      if (!children.some(child => child.id === path.child?.id))
        throw new Error(`TARGET_NOT_FOUND: ${target}`);
    }
    return { record, analysis, target: canonical };
  }
  const scope =
    path.collection === 'analyses' && path.id
      ? [...path.scope, path.id]
      : path.scope;
  const analysis = data.index.analysisByPath.get(scope.join('.') || '$');
  if (!analysis) throw new Error(`TARGET_NOT_FOUND: ${target}`);
  return { analysis, target: analysis.canonicalPath };
}

/** Papers keep their DOI identity instead of inventing a MySTRA role syntax. */
export function resolveReference(
  data: ILoadedProjectData,
  reference: IElementReference
): IResolvedElement {
  if (!reference.doi) return resolveElement(data, reference.target);
  const analysis = data.document.analysis;
  const paper = collectInventoryPapers(
    data.document,
    data.index,
    analysis,
    data.papers
  ).find(paper => paper.doi === reference.doi);
  if (!paper)
    throw new Error(
      `TARGET_NOT_FOUND: DOI ${reference.doi} is not cited in this project.`
    );
  return { analysis, paper, target: `doi:${paper.doi}` };
}
