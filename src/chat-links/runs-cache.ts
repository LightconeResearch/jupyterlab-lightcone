import type { ServerConnection } from '@jupyterlab/services';
import { listRuns, type IRunListing } from '../runs/runs-api';

/** How long a run listing serves footers before it is fetched again. */
export const RUNS_CACHE_TTL = 30_000;

/**
 * How far the browser's clock may be from the server's, in seconds. Turn
 * times are stamped by the server and listing times by the browser, so a
 * listing proves it saw a turn's commits only when it was requested this
 * long after the turn ended.
 */
export const CLOCK_SKEW_ALLOWANCE = 60;

interface ICachedListing {
  /** When the listing was requested, browser time in seconds since the epoch. */
  at: number;
  listing: Promise<IRunListing>;
}

const listings = new Map<string, ICachedListing>();

/**
 * The project's run listing, shared by every footer for up to 30 s.
 *
 * `notBefore` is the server time (seconds since the epoch) of the end of the
 * turn the caller shows. A cached listing is reused only when it was requested
 * at least `CLOCK_SKEW_ALLOWANCE` after that, by the browser's clock; a
 * recent turn therefore always gets a fresh listing, which contains every
 * commit the turn made, while footers of older turns share one request.
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
    cached.at >= notBefore + CLOCK_SKEW_ALLOWANCE
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
