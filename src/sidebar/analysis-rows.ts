import type { ResolvedAnalysisNode } from '@astra-spec/sdk';
import { analysisTitle, collectInventoryPapers } from '@astra-spec/ui/model';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { ILoadedProjectData } from '../project-data';

/** One analysis of the project, with the counts the Analysis section shows. */
export interface IAnalysisRow {
  canonicalPath: string;
  title: string;
  /** Nesting depth; the root analysis is 0. */
  depth: number;
  outputs: number;
  decisions: number;
  inputs: number;
  findings: number;
  papers: number;
}

/** The analysis tree flattened depth first, root first. */
export function analysisRows(data: ILoadedProjectData): IAnalysisRow[] {
  const rows: IAnalysisRow[] = [];
  const visit = (node: ResolvedAnalysisNode, depth: number): void => {
    rows.push({
      canonicalPath: node.canonicalPath,
      title: analysisTitle(node),
      depth,
      outputs: node.outputs.length,
      decisions: node.decisions.length,
      inputs: node.inputs.length,
      findings: node.findings.length,
      papers: collectInventoryPapers(
        data.document,
        data.index,
        node,
        data.papers
      ).length
    });
    for (const child of node.analyses) {
      visit(child, depth + 1);
    }
  };
  visit(data.document.analysis, 0);
  return rows;
}

/** One kind's count on an analysis row, in the inventory's section order. */
export interface IAnalysisCount {
  kind: 'output' | 'decision' | 'input' | 'finding' | 'paper';
  count: number;
  /** The inventory's section name: "Outputs", "Decisions", … */
  label: string;
}

/** The row's non-empty counts, in the inventory's section order. */
export function analysisCounts(
  row: IAnalysisRow,
  trans: TranslationBundle
): IAnalysisCount[] {
  const counts: IAnalysisCount[] = [
    { kind: 'output', count: row.outputs, label: trans.__('Outputs') },
    { kind: 'decision', count: row.decisions, label: trans.__('Decisions') },
    { kind: 'input', count: row.inputs, label: trans.__('Inputs') },
    { kind: 'finding', count: row.findings, label: trans.__('Findings') },
    { kind: 'paper', count: row.papers, label: trans.__('Papers') }
  ];
  return counts.filter(entry => entry.count > 0);
}

/**
 * "Outputs 2 · Decisions 5 · Inputs 7 · Findings 2 · Papers 3", in the
 * inventory's section order, omitting empty kinds.
 */
export function analysisCountsLabel(
  row: IAnalysisRow,
  trans: TranslationBundle
): string {
  const parts = analysisCounts(row, trans).map(
    entry => `${entry.label} ${entry.count}`
  );
  return parts.length ? parts.join(' · ') : trans.__('No records yet');
}
