import { PathExt } from '@jupyterlab/coreutils';
import type { ServerConnection } from '@jupyterlab/services';
import { Token } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import {
  createComment,
  deleteComment,
  listComments,
  sendComments,
  updateComment,
  type IComment,
  type ICommentDraft,
  type ICommentPatch
} from './comments-api';

/** Pending comments of each project, shared by the tray, pins and the sidebar. */
export interface ICommentService {
  /** The pending comments of the project owning `entrypoint`, as last fetched. */
  pending(entrypoint: string): readonly IComment[];
  /** Fetch the pending comments again. */
  refresh(entrypoint: string): Promise<void>;
  /** Save a new comment and return it. */
  add(entrypoint: string, draft: ICommentDraft): Promise<IComment>;
  /** Change a pending comment. */
  update(
    entrypoint: string,
    id: string,
    patch: ICommentPatch
  ): Promise<IComment>;
  /** Delete a pending comment. */
  remove(entrypoint: string, id: string): Promise<void>;
  /** Emitted with the entrypoint whose pending comments changed. */
  readonly changed: ISignal<ICommentService, string>;
}

/** The token the comments plugin provides. */
export const ICommentService = new Token<ICommentService>(
  'jupyterlab_lightcone:ICommentService',
  'Pending comments on ASTRA elements and project files.'
);

const EMPTY: readonly IComment[] = Object.freeze([]);

/** How long a full listing (sent comments included) is reused, in ms. */
const ALL_CACHE_TTL = 30_000;

/**
 * The comments of each project as the workbench last saw them. Pending
 * comments are cached per entrypoint and fetched once on first use; every
 * write updates the cache and emits `changed`, so pins, tray and sidebar
 * redraw together. Sent comments are fetched on demand for message cards.
 */
export class CommentService implements ICommentService, IDisposable {
  constructor(private settings: ServerConnection.ISettings) {}

  get changed(): ISignal<ICommentService, string> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  pending(entrypoint: string): readonly IComment[] {
    const key = this.key(entrypoint);
    const cached = this._pending.get(key);
    if (cached) {
      return cached;
    }
    if (!this._inflight.has(key)) {
      void this.refresh(key).catch(error => {
        console.warn('Could not load the pending Lightcone comments.', error);
      });
    }
    return EMPTY;
  }

  /** Whether the pending comments of a project were fetched at least once. */
  known(entrypoint: string): boolean {
    return this._pending.has(this.key(entrypoint));
  }

  /**
   * Mark comments sent with a chat's next message and return the block the
   * composer appends to it, for servers that do not append it to the prompt.
   */
  async send(
    entrypoint: string,
    ids: readonly string[],
    chat: string
  ): Promise<string | null> {
    const key = this.key(entrypoint);
    const block = await sendComments(this.settings, key, ids, chat);
    const sent = new Set(ids);
    this.store(
      key,
      (this._pending.get(key) ?? []).filter(item => !sent.has(item.id))
    );
    return block;
  }

  async refresh(entrypoint: string): Promise<void> {
    const key = this.key(entrypoint);
    let request = this._inflight.get(key);
    if (!request) {
      request = listComments(this.settings, key, { status: 'pending' })
        .then(comments => {
          if (this._inflight.get(key) === request) {
            this.store(key, comments);
          }
        })
        .finally(() => {
          if (this._inflight.get(key) === request) {
            this._inflight.delete(key);
          }
        });
      this._inflight.set(key, request);
    }
    return request;
  }

  async add(entrypoint: string, draft: ICommentDraft): Promise<IComment> {
    const key = this.key(entrypoint);
    const comment = await createComment(this.settings, key, draft);
    this.store(key, [...(this._pending.get(key) ?? []), comment]);
    return comment;
  }

  async update(
    entrypoint: string,
    id: string,
    patch: ICommentPatch
  ): Promise<IComment> {
    const key = this.key(entrypoint);
    const comment = await updateComment(this.settings, key, id, patch);
    const current = this._pending.get(key) ?? [];
    this.store(
      key,
      current.some(item => item.id === id)
        ? current.map(item => (item.id === id ? comment : item))
        : [...current, comment]
    );
    return comment;
  }

  async remove(entrypoint: string, id: string): Promise<void> {
    const key = this.key(entrypoint);
    await deleteComment(this.settings, key, id);
    const current = this._pending.get(key) ?? [];
    this.store(
      key,
      current.filter(item => item.id !== id)
    );
    // The server renumbers the remaining labels of that target. The delete
    // itself succeeded: a failed refresh only leaves the old labels showing
    // until the next one, and must not report the delete as failed.
    await this.refresh(key).catch(error => {
      console.warn(
        'Could not fetch the renumbered pending comments after a delete.',
        error
      );
    });
  }

  /** Every comment of the project, sent ones included, reused for a while. */
  async all(entrypoint: string): Promise<readonly IComment[]> {
    const key = this.key(entrypoint);
    const cached = this._all.get(key);
    if (cached && Date.now() - cached.time < ALL_CACHE_TTL) {
      return cached.comments;
    }
    const request: Promise<readonly IComment[]> =
      cached?.request ??
      listComments(this.settings, key, { status: 'all' }).then(comments => {
        // A write or disposal may have invalidated this listing while it
        // was in flight; only its current request can fill the cache.
        if (!this._isDisposed && this._all.get(key)?.request === request) {
          this._all.set(key, { time: Date.now(), comments });
        }
        return comments;
      });
    this._all.set(key, {
      time: cached?.time ?? 0,
      comments: cached?.comments ?? EMPTY,
      request
    });
    try {
      return await request;
    } finally {
      const entry = this._all.get(key);
      if (entry?.request === request) {
        this._all.set(key, { time: entry.time, comments: entry.comments });
      }
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._pending.clear();
    this._all.clear();
    this._inflight.clear();
    Signal.clearData(this);
  }

  private key(entrypoint: string): string {
    return PathExt.normalize(entrypoint);
  }

  private store(key: string, comments: readonly IComment[]): void {
    if (this._isDisposed) {
      return;
    }
    const previous = this._pending.get(key);
    const next = Object.freeze([...comments]);
    // A successful write supersedes listings started before it. A later
    // refresh must get its own request (not reuse the stale one).
    this._inflight.delete(key);
    this._pending.set(key, next);
    this._all.delete(key);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
      this._changed.emit(key);
    }
  }

  private _pending = new Map<string, readonly IComment[]>();
  private _inflight = new Map<string, Promise<void>>();
  private _all = new Map<
    string,
    {
      time: number;
      comments: readonly IComment[];
      request?: Promise<readonly IComment[]>;
    }
  >();
  private _changed = new Signal<ICommentService, string>(this);
  private _isDisposed = false;
}
