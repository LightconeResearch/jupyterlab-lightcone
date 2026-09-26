import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/model';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { ILoadedProjectData } from '../project-data';

/**
 * The project's results: the root analysis's outputs that the selected
 * universe makes, in document order. This is the set Home shows and the only
 * one `lc status` reports on; nested analyses' outputs stay in their
 * inventory scope, which the Analysis section opens.
 */
export function listOutputs(data: ILoadedProjectData): ResolvedOutput[] {
  return data.document.analysis.outputs.filter(output => output.active);
}

/**
 * How Home's plates and the sidebar's Results name an output type: the
 * ASTRA types by name, any other type capitalised, and "Output" when the
 * output declares none.
 */
export function outputKindLabel(
  type: string | undefined,
  trans: TranslationBundle
): string {
  switch (type) {
    case 'figure':
      return trans.__('Figure');
    case 'table':
      return trans.__('Table');
    case 'metric':
      return trans.__('Metric');
    case 'data':
      return trans.__('Data');
    case 'report':
      return trans.__('Report');
    default:
      return type ? type[0].toUpperCase() + type.slice(1) : trans.__('Output');
  }
}

/** Counts of the Results section by materialization state. */
export interface IResultsSummary {
  total: number;
  current: number;
  behind: number;
  stale: number;
  unknown: number;
}

/** Tally outputs by their `lc status` state; unknown when there is no report. */
export function summarizeResults(
  outputs: readonly ResolvedOutput[],
  statusFor: (output: ResolvedOutput) => OutputStatus | undefined
): IResultsSummary {
  const summary: IResultsSummary = {
    total: outputs.length,
    current: 0,
    behind: 0,
    stale: 0,
    unknown: 0
  };
  for (const output of outputs) {
    const status = statusFor(output);
    if (!status) {
      summary.unknown += 1;
    } else {
      summary[status.state] += 1;
    }
  }
  return summary;
}

/** The Results header label: "4 ✓", "3 ✓ · 1 behind", or a plain count. */
export function resultsSummaryLabel(
  summary: IResultsSummary,
  trans: TranslationBundle
): string {
  if (!summary.total) {
    return '0';
  }
  if (summary.current === summary.total) {
    return trans.__('%1 ✓', summary.total);
  }
  const parts: string[] = [];
  if (summary.current) {
    parts.push(trans.__('%1 ✓', summary.current));
  }
  if (summary.behind) {
    parts.push(trans.__('%1 behind', summary.behind));
  }
  if (summary.stale) {
    parts.push(trans.__('%1 stale', summary.stale));
  }
  return parts.length ? parts.join(' · ') : `${summary.total}`;
}
