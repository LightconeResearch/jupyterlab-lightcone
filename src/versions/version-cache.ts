import type { ServerConnection } from '@jupyterlab/services';
import { listVersions, type IVersionListing } from './versions-api';

/** Listings younger than this are shared between cards and tabs. */
export const VERSION_CACHE_MAX_AGE_MS = 30_000;

interface ICacheEntry {
  at: number;
  listing: Promise<IVersionListing>;
}

const cache = new Map<string, ICacheEntry>();

function cacheKey(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string
): string {
  return JSON.stringify([settings.baseUrl, entrypoint, universe, output]);
}

/**
 * List an output's versions, sharing one request between every card and
 * tab that asks within `maxAgeMs`. A failed request is not cached.
 */
export function listVersionsCached(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string,
  maxAgeMs = VERSION_CACHE_MAX_AGE_MS
): Promise<IVersionListing> {
  const key = cacheKey(settings, entrypoint, universe, output);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < maxAgeMs) return cached.listing;
  const listing = listVersions(settings, entrypoint, universe, output);
  const entry = { at: now, listing };
  cache.set(key, entry);
  listing.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return listing;
}

/** Forget a cached listing, e.g. after a new materialization was noticed. */
export function forgetVersions(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string
): void {
  cache.delete(cacheKey(settings, entrypoint, universe, output));
}
