import type { ServerConnection } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import {
  listResultsCommits,
  type IResultsCommit
} from '../versions/versions-api';

/** How long a results history serves footers before it is fetched again. */
export const RESULTS_CACHE_TTL = 30_000;

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
  listing: Promise<IResultsCommit[]>;
}

/**
 * The results histories of projects, shared by every footer for up to 30 s
 * each. Owned by the chat-links plugin, which disposes it with the shell.
 */
export class ResultsHistoryCache implements IDisposable {
  constructor(private readonly _settings: ServerConnection.ISettings) {}

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * The project's results history.
   *
   * `notBefore` is the server time (seconds since the epoch) of the end of
   * the turn the caller shows. A cached listing is reused only when it was
   * requested at least `CLOCK_SKEW_ALLOWANCE` after that, by the browser's
   * clock; a recent turn therefore always gets a fresh listing, which
   * contains every commit the turn made, while footers of older turns share
   * one request.
   */
  get(entrypoint: string, notBefore = 0): Promise<IResultsCommit[]> {
    const now = Date.now() / 1000;
    const cached = this._listings.get(entrypoint);
    if (
      cached &&
      now - cached.at < RESULTS_CACHE_TTL / 1000 &&
      cached.at >= notBefore + CLOCK_SKEW_ALLOWANCE
    ) {
      return cached.listing;
    }
    const listing = listResultsCommits(this._settings, entrypoint);
    const entry = { at: now, listing };
    this._listings.set(entrypoint, entry);
    listing.catch(() => {
      if (this._listings.get(entrypoint) === entry) {
        this._listings.delete(entrypoint);
      }
    });
    return listing;
  }

  /** Forget every listing, so the next footer fetches afresh. */
  clear(): void {
    this._listings.clear();
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.clear();
  }

  private readonly _listings = new Map<string, ICachedListing>();
  private _isDisposed = false;
}
