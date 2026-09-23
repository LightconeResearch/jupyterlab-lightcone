import type { ResolvedRecord } from '@astra-spec/sdk';
import type { Contents } from '@jupyterlab/services';
import type { IAstraCardVersion } from '../astra-mime-data';
import { isRootAnalysisOutput } from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import { forgetVersions, listVersionsCached } from './version-cache';

/**
 * The committed version a preview card should pin: the newest commit of the
 * output's file, when the record is a root-analysis output on the local drive
 * and the engine has committed it. Anything else (another record kind, an
 * output never materialized, a history that cannot be read) pins nothing, so
 * the card keeps following the current data.
 */
export async function latestCardVersion(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  record: ResolvedRecord | undefined
): Promise<IAstraCardVersion | undefined> {
  if (
    record?.kind !== 'output' ||
    !isRootAnalysisOutput(data.index, record) ||
    contents.driveName(entrypoint)
  )
    return undefined;
  const settings = contents.serverSettings;
  const universe = data.document.universe.universeId;
  // A card records what the agent shows now: a cached history could predate
  // the run the agent just made.
  forgetVersions(settings, entrypoint, universe, record.id);
  try {
    const listing = await listVersionsCached(
      settings,
      entrypoint,
      universe,
      record.id
    );
    const newest = listing.versions[0];
    if (!newest) return undefined;
    return newest.key
      ? { commit: newest.commit, key: newest.key }
      : { commit: newest.commit };
  } catch {
    return undefined;
  }
}
