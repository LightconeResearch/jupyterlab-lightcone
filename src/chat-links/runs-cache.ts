import type { ServerConnection } from '@jupyterlab/services';
import { listRuns, type IRunListing } from '../runs/runs-api';

/** How long a run listing serves footers before it is fetched again. */
export const RUNS_CACHE_TTL = 30_000;

interface ICachedListing {
  /** When the listing was requested, seconds since the epoch. */
  at: number;
  listing: Promise<IRunListing>;
}

const listings = new Map<string, ICachedListing>();

/**
 * The project's run listing, shared by every footer for up to 30 s. A listing
 * fetched before `notBefore` (seconds since the epoch) cannot know runs made
 * after it, so a caller whose turn ended later forces a fresh request.
 */
export function cachedRuns(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  notBefore = 0
): Promise<IRunListing> {
  const now = Date.now() / 1000;
  const cached = listings.get(entrypoint);
  if (
    cached &&
    now - cached.at < RUNS_CACHE_TTL / 1000 &&
    cached.at >= notBefore
  ) {
    return cached.listing;
  }
  const listing = listRuns(settings, entrypoint);
  const entry = { at: now, listing };
  listings.set(entrypoint, entry);
  listing.catch(() => {
    if (listings.get(entrypoint) === entry) {
      listings.delete(entrypoint);
    }
  });
  return listing;
}
