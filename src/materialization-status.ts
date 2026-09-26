import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import { Poll } from '@lumino/polling';
import { useEffect, useState } from 'react';
import {
  fetchMaterializationStatuses,
  type MaterializationStatuses
} from './materialization-api';
import { isUnderProject, type ILoadedProjectData } from './project-data';

/** The CLI reports status, and Lightcone records runs, only for the root analysis. */
export function isRootAnalysisOutput(
  index: AnalysisIndex,
  output: ResolvedOutput
): boolean {
  return (
    index.analysisByRecordPath.get(output.canonicalPath)?.canonicalPath === '$'
  );
}

/** Match CLI output IDs only in their owning root analysis and selected universe. */
export function outputMaterializationStatus(
  statuses: MaterializationStatuses | undefined,
  data: ILoadedProjectData,
  output: ResolvedOutput
): OutputStatus | undefined {
  if (!isRootAnalysisOutput(data.index, output)) {
    return undefined;
  }
  return statuses?.[`${data.document.universe.universeId}/${output.id}`];
}

/** Poll only while the inventory is mounted and visible; failures clear old checks. */
export function useMaterializationStatus(
  contents: Contents.IManager,
  entrypoint: string,
  document: ILoadedProjectData['document']
): { statuses?: MaterializationStatuses; error?: string } {
  const [result, setResult] = useState<{
    contents: Contents.IManager;
    document: ILoadedProjectData['document'];
    entrypoint: string;
    statuses?: MaterializationStatuses;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    const publish = (value: {
      statuses?: MaterializationStatuses;
      error?: string;
    }) => {
      if (active) {
        setResult({ contents, document, entrypoint, ...value });
      }
    };
    const poll = new Poll({
      name: `jupyterlab_lightcone:materialization:${entrypoint}`,
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: 'when-hidden',
      factory: async () => {
        try {
          publish({
            statuses: await fetchMaterializationStatuses(contents, entrypoint)
          });
        } catch (error) {
          publish({
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    });
    // A change anywhere in the project may be a run finishing.
    const changed = (
      _sender: Contents.IManager,
      change: Contents.IChangedArgs
    ) => {
      if (
        [change.oldValue?.path, change.newValue?.path].some(
          path =>
            path !== undefined && isUnderProject(contents, entrypoint, path)
        )
      ) {
        void poll.refresh();
      }
    };
    contents.fileChanged.connect(changed);
    return () => {
      active = false;
      contents.fileChanged.disconnect(changed);
      poll.dispose();
    };
  }, [contents, entrypoint, document]);
  return result?.contents === contents &&
    result.document === document &&
    result.entrypoint === entrypoint
    ? result
    : {};
}
