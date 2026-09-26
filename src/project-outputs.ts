import type { ResolvedOutput } from '@astra-spec/sdk';
import type { ILoadedProjectData } from './project-data';

/**
 * The project's results: the root analysis's outputs that the selected
 * universe makes, in document order. This is the set Home shows and the only
 * one `lc status` reports on; nested analyses' outputs stay in their
 * inventory scope, which the Analysis section opens.
 */
export function listOutputs(data: ILoadedProjectData): ResolvedOutput[] {
  return data.document.analysis.outputs.filter(output => output.active);
}
