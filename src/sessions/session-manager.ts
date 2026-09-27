import type { IChatModel, IChatPanel, IChatTracker } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { Signal, type ISignal } from '@lumino/signaling';
import { Widget, type DockLayout } from '@lumino/widgets';
import { isRecord } from '../api';
import { isUnderProject, projectDirectory } from '../project-data';
import {
  CHAT_FACTORY,
  CREATE_CHAT_COMMAND,
  ELEMENT_TAB_DATASET_KEY,
  SESSION_TITLE_DATASET_KEY
} from '../workbench-ids';
import type { ISessionService, ISessionStartOptions } from './session-service';
import {
  slugForTitle,
  titleFromMessage,
  uniqueSessionName,
  SESSION_FILE_EXTENSION,
  UNTITLED_SLUG
} from './session-titles';
import {
  listSessions,
  type ISessionInfo,
  type ISessionListing
} from './sessions-api';
import { isPersonaUser } from './session-user';

export { CHAT_FACTORY, SESSION_TITLE_DATASET_KEY } from '../workbench-ids';

/** A listing this recent is reused instead of fetched again. */
const LISTING_TTL = 2000;
/**
 * Listings a caller of `list()` asked for this recently are refreshed on
 * every poll tick; older ones are forgotten. The poll's own refreshes do not
 * count as requests.
 */
const ACTIVE_WINDOW = 10 * 60 * 1000;
const POLL_INTERVAL = 15000;
/**
 * How long a new session must stay quiet (nobody writing, no message
 * changing) before its file is renamed after its first message. The server
 * learns of a rename a moment after it happens; a reply saved in that moment
 * would recreate the old file.
 */
export const RENAME_QUIET_PERIOD = 2000;
/** The project folder that holds sessions (`CHATS_DIRECTORY` in `sessions.py`). */
const CHATS_DIRECTORY = 'chats';
/** Dependencies of the session manager, narrowed for testing. */
export interface ISessionManagerOptions {
  commands: CommandRegistry;
  shell: JupyterFrontEnd.IShell;
  contents: Contents.IManager;
  /** The document manager, which opens chat documents in the main area. */
  documents: IDocumentManager;
  /** Jupyter Chat's panel tracker; null when Jupyter Chat is absent. */
  tracker: IChatTracker | null;
  /** The Lab shell, for focus changes; null in other shells. */
  labShell: ILabShell | null;
  translator?: ITranslator;
}

interface ICachedListing {
  listing: ISessionListing;
  fetchedAt: number;
  /** When a caller of `list()` last asked for this listing. */
  requestedAt: number;
  signature: string;
}

/** A listing request in flight, and the version of the project's chats it asked about. */
interface IPendingListing {
  version: number;
  listing: Promise<ISessionListing>;
}

/** Where the document manager puts a session in the main area. */
interface ISessionPlacement {
  mode?: DockLayout.InsertMode;
  ref?: string;
}

/**
 * The live state of one open chat. When the same chat is open twice (in the
 * main area and in Jupyter Chat's side panel), one panel carries it: the
 * main-area session when there is one.
 */
interface ILiveSession {
  panel: IChatPanel;
  /** Local Contents path of the chat file, the key of `_live`. */
  path: string;
  /** Name only chats whose first human message arrives while open. */
  titledWhenLoaded?: boolean;
  /**
   * Whether this window tried to name the file after its first message. It
   * tries once: another window may have renamed it already.
   */
  named?: boolean;
  /** The rename waiting for the session to go quiet. */
  naming?: ReturnType<typeof setTimeout>;
  disconnect: () => void;
}

/**
 * A session file still called `untitled` in a project's `chats/` folder, the
 * folder the server lists sessions from.
 */
const UNTITLED_SESSION = new RegExp(
  `(^|/)${CHATS_DIRECTORY}/${UNTITLED_SLUG}(-\\d+)?${SESSION_FILE_EXTENSION.replace('.', '\\.')}$`
);

/**
 * Whether a session is still named `untitled`: created in `chats/` before its
 * first message was written, as New session and Lightcone Agent create them.
 */
export function isUntitledSession(localPath: string): boolean {
  return UNTITLED_SESSION.test(localPath);
}

function isChatModel(value: unknown): value is IChatModel {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isRecord(value.input) &&
    Array.isArray(value.messages) &&
    'ready' in value
  );
}

/**
 * Whether a widget is one of Jupyter Chat's panels, wherever it is shown.
 * For a widget the chat tracker may know, `trackedSession` asks the tracker
 * instead of probing the widget's shape.
 */
export function isChatPanel(value: unknown): value is IChatPanel {
  return (
    value instanceof Widget &&
    'model' in value &&
    isChatModel(value.model) &&
    'area' in value &&
    (value.area === 'main' || value.area === 'sidebar')
  );
}

/** Whether a widget is a session: a chat document open in the main area. */
export function isSessionWidget(value: unknown): value is IChatPanel {
  return isChatPanel(value) && value.area === 'main';
}

/**
 * The main-area session a shell widget is, by the chat tracker's word;
 * undefined for every other widget, and without a tracker.
 */
export function trackedSession(
  tracker: IChatTracker | null,
  widget: Widget | null | undefined
): IChatPanel | undefined {
  if (!tracker || !widget) {
    return undefined;
  }
  return tracker.find(panel => panel === widget && panel.area === 'main');
}

/** Whether a widget is a record tab: results form their own column. */
export function isRecordTab(widget: Widget): boolean {
  return widget.title.dataset[ELEMENT_TAB_DATASET_KEY] !== undefined;
}

/**
 * The title a chat's messages give it: the first line of its first message
 * not sent by a persona; empty before anyone wrote.
 */
export function messagesTitle(messages: IChatModel['messages']): string {
  const first = messages.find(
    message => !isPersonaUser(message.sender) && message.body.trim()
  );
  return first ? titleFromMessage(first.body) : '';
}

/**
 * Show a main-area session's title on its tab, or its file name while it has
 * none. Only the title's dataset changes, so the file keeps its name.
 */
export function syncSessionTabTitle(panel: IChatPanel): void {
  if (panel.isDisposed || panel.area !== 'main') {
    return;
  }
  const title = messagesTitle(panel.model.messages);
  const { [SESSION_TITLE_DATASET_KEY]: shown, ...others } = panel.title.dataset;
  if ((title || undefined) === shown) {
    return;
  }
  panel.title.dataset = title
    ? { ...others, [SESSION_TITLE_DATASET_KEY]: title }
    : others;
}

/**
 * Project-scoped sessions: lists them through the server, opens them as
 * main-area chat documents, and names new sessions after their first message.
 */
export class SessionManager implements ISessionService, IDisposable {
  constructor(options: ISessionManagerOptions) {
    this._commands = options.commands;
    this._shell = options.shell;
    this._contents = options.contents;
    this._documents = options.documents;
    this._tracker = options.tracker;
    this._labShell = options.labShell;
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this._tracker?.forEach(panel => this._track(panel));
    this._tracker?.widgetAdded.connect(this._onPanelAdded, this);
    this._labShell?.currentChanged.connect(this._onCurrentChanged, this);
    this._contents.fileChanged.connect(this._onFileChanged, this);
    this._poll = new Poll<void, unknown>({
      factory: () => this._pollListings(),
      frequency: { interval: POLL_INTERVAL, backoff: false },
      name: 'jupyterlab_lightcone:sessions',
      standby: 'when-hidden'
    });
  }

  get changed(): ISignal<this, string> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** The sessions of a project, newest first. */
  async list(entrypoint: string): Promise<ISessionInfo[]> {
    return (await this._listing(entrypoint)).sessions;
  }

  async createAndOpen(
    entrypoint: string,
    options: ISessionStartOptions = {}
  ): Promise<string> {
    if (!this._commands.hasCommand(CREATE_CHAT_COMMAND)) {
      throw new Error(
        this._trans.__(
          'Jupyter Chat is not available, so no session can be started.'
        )
      );
    }
    const key = this._contents.normalize(entrypoint);
    // Saving the `chats` folder as a directory creates it when it is missing
    // and leaves it alone otherwise.
    const directory = this._contents.resolvePath(
      projectDirectory(key),
      CHATS_DIRECTORY
    );
    await this._contents.save(directory, { type: 'directory' });
    const title = options.title?.trim() ?? '';
    const name = await uniqueSessionName(
      this._contents,
      directory,
      slugForTitle(title)
    );
    const created: unknown = await this._commands.execute(CREATE_CHAT_COMMAND, {
      path: directory,
      name
    });
    if (typeof created !== 'string' || !created) {
      throw new Error(this._trans.__('The session file could not be created.'));
    }
    this._invalidate(key);
    const panel = await this._open(created);
    if (options.draft) {
      await this._draft(panel, options.draft);
    }
    return created;
  }

  async openSession(path: string): Promise<void> {
    await this._open(path);
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._poll.dispose();
    this._tracker?.widgetAdded.disconnect(this._onPanelAdded, this);
    this._labShell?.currentChanged.disconnect(this._onCurrentChanged, this);
    this._contents.fileChanged.disconnect(this._onFileChanged, this);
    for (const live of this._live.values()) {
      live.disconnect();
    }
    this._live.clear();
    this._listings.clear();
    this._fetches.clear();
    Signal.clearData(this);
  }

  /** Activate an open session, or open the chat document beside the current work. */
  private async _open(path: string): Promise<IChatPanel> {
    const existing = this._findPanel(path);
    if (existing) {
      this._shell.activateById(existing.id);
      existing.model.input.focus();
      return existing;
    }
    const opened = this._documents.openOrReveal(path, CHAT_FACTORY, undefined, {
      ...this._placement(),
      activate: true
    });
    if (!isSessionWidget(opened)) {
      throw new Error(
        this._trans.__(
          'The session did not open. Check that Jupyter AI is enabled.'
        )
      );
    }
    return opened;
  }

  /**
   * Keep sessions and results in columns: sessions in one tab group, their results split
   * to its right. A session joins the open session's group. Without one, it
   * takes the main stage in the current widget's group (Home or a document
   * stays one tab away), except from a result: there it splits to the left,
   * so the result column stays beside it and later results never cover it.
   * An empty main area opens it plainly.
   */
  private _placement(): ISessionPlacement {
    const session = this._sessionColumn();
    if (session) {
      return { mode: 'tab-after', ref: session.id };
    }
    const current = this._shell.currentWidget;
    if (!current) {
      return {};
    }
    return {
      mode: isRecordTab(current) ? 'split-left' : 'tab-after',
      ref: current.id
    };
  }

  /**
   * The session whose tab group new sessions join: the current widget when it
   * is a session, else the session the user last worked in, else any session
   * open in the main area.
   */
  private _sessionColumn(): IChatPanel | undefined {
    const usable = (panel: IChatPanel | null | undefined) =>
      !!panel &&
      !panel.isDisposed &&
      panel.area === 'main' &&
      this._inMainArea(panel);
    const current = trackedSession(this._tracker, this._shell.currentWidget);
    if (usable(current)) {
      return current;
    }
    if (usable(this._lastSession)) {
      return this._lastSession ?? undefined;
    }
    return this._tracker?.find(panel => usable(panel));
  }

  private _inMainArea(widget: Widget): boolean {
    for (const candidate of this._shell.widgets('main')) {
      if (candidate === widget) {
        return true;
      }
    }
    return false;
  }

  private _findPanel(path: string): IChatPanel | undefined {
    const local = this._contents.localPath(path);
    return this._tracker?.find(
      panel =>
        panel.area === 'main' &&
        this._contents.localPath(panel.model.name) === local
    );
  }

  /** Leave text in the composer of a session that just opened, for the user to finish. */
  private async _draft(panel: IChatPanel, text: string): Promise<void> {
    const model = panel.model;
    await model.ready;
    if (panel.isDisposed) {
      return;
    }
    const current = model.input.value;
    model.input.value = current ? `${current}\n\n${text}` : text;
    model.input.focus();
  }

  /** A caller's request for a listing: counts as activity, reuses a fresh one. */
  private async _listing(entrypoint: string): Promise<ISessionListing> {
    const key = this._contents.normalize(entrypoint);
    const cached = this._listings.get(key);
    const now = Date.now();
    if (cached) {
      cached.requestedAt = now;
      if (now - cached.fetchedAt < LISTING_TTL) {
        return cached.listing;
      }
    }
    return this._refresh(key);
  }

  /**
   * Fetch a listing, sharing a request already in flight unless the project's
   * chats changed since it was sent. It leaves `requestedAt` alone, so the
   * poll's refreshes never keep a listing alive.
   */
  private _refresh(key: string): Promise<ISessionListing> {
    const version = this._versions.get(key) ?? 0;
    const pending = this._fetches.get(key);
    if (pending?.version === version) {
      return pending.listing;
    }
    const listing = this._fetch(key, version).finally(() => {
      if (this._fetches.get(key)?.listing === listing) {
        this._fetches.delete(key);
      }
    });
    this._fetches.set(key, { version, listing });
    return listing;
  }

  /** Fetch a listing; one the project's chats changed during is returned but not kept. */
  private async _fetch(key: string, version: number): Promise<ISessionListing> {
    const listing = await listSessions(this._contents.serverSettings, key);
    if (this._isDisposed || (this._versions.get(key) ?? 0) !== version) {
      return listing;
    }
    const signature = JSON.stringify(listing.sessions);
    const previous = this._listings.get(key);
    const now = Date.now();
    this._listings.set(key, {
      listing,
      fetchedAt: now,
      requestedAt: previous?.requestedAt ?? now,
      signature
    });
    if (previous && previous.signature !== signature) {
      this._changed.emit(key);
    }
    return listing;
  }

  /** Mark a project's listing stale, including a request already in flight, and announce it. */
  private _invalidate(key: string): void {
    this._versions.set(key, (this._versions.get(key) ?? 0) + 1);
    const cached = this._listings.get(key);
    if (cached) {
      cached.fetchedAt = 0;
    }
    this._changed.emit(key);
  }

  private async _pollListings(): Promise<void> {
    const now = Date.now();
    for (const [key, cached] of [...this._listings]) {
      if (now - cached.requestedAt > ACTIVE_WINDOW) {
        this._listings.delete(key);
        continue;
      }
      try {
        await this._refresh(key);
      } catch (error) {
        console.warn('Could not refresh the Lightcone sessions.', error);
      }
    }
  }

  private _onPanelAdded(_tracker: IChatTracker, panel: IChatPanel): void {
    this._track(panel);
  }

  /** Follow message changes so newly written sessions acquire a title. */
  private _track(panel: IChatPanel): void {
    if (panel.isDisposed || panel.area !== 'main') return;
    const path = this._contents.localPath(panel.model.name);
    if (this._live.has(path)) return;
    const model = panel.model;
    const update = () => {
      syncSessionTabTitle(panel);
      this._scheduleNaming(live);
    };
    const onDisposed = () => {
      live.disconnect();
      this._live.delete(live.path);
      if (this._lastSession === panel) this._lastSession = null;
    };
    const live: ILiveSession = {
      panel,
      path,
      disconnect: () => {
        clearTimeout(live.naming);
        model.messagesUpdated.disconnect(update);
        model.messageChanged.disconnect(update);
        model.writersChanged?.disconnect(update);
        panel.disposed.disconnect(onDisposed);
      }
    };
    this._live.set(path, live);
    model.messagesUpdated.connect(update);
    model.messageChanged.connect(update);
    model.writersChanged?.connect(update);
    panel.disposed.connect(onDisposed);
    void model.ready
      .then(() => {
        if (this._isDisposed || this._live.get(live.path) !== live) return;
        live.titledWhenLoaded = !!messagesTitle(model.messages);
        update();
      })
      .catch(error => console.warn('Could not load the session title.', error));
    syncSessionTabTitle(panel);
  }

  /**
   * The slug an untitled session's file takes from its first message, or
   * null when this window should not rename it: a chat that already had
   * messages when it loaded, one outside `chats/` or with a name of its own,
   * one this window tried to name already, and one nobody wrote in yet.
   */
  private _namingSlug(live: ILiveSession): string | null {
    if (
      live.titledWhenLoaded !== false ||
      live.named ||
      live.panel.isDisposed ||
      live.panel.area !== 'main' ||
      !isUntitledSession(live.path)
    ) {
      return null;
    }
    const title = messagesTitle(live.panel.model.messages);
    const slug = title ? slugForTitle(title) : UNTITLED_SLUG;
    return slug === UNTITLED_SLUG ? null : slug;
  }

  /** Name an untitled session once it has been quiet for a while; every change restarts the wait. */
  private _scheduleNaming(live: ILiveSession): void {
    clearTimeout(live.naming);
    live.naming = undefined;
    if (this._namingSlug(live) === null) {
      return;
    }
    live.naming = setTimeout(() => {
      live.naming = undefined;
      this._nameAfterFirstMessage(live);
    }, RENAME_QUIET_PERIOD);
  }

  /**
   * Name a session created without a message after its first one, as Home
   * names the sessions it starts: `chats/untitled.chat` becomes
   * `chats/<slug of the first line>.chat`. Jupyter Chat and this manager
   * follow the rename. It waits while anyone writes, since the server saves
   * every streamed reply, and is tried once.
   */
  private _nameAfterFirstMessage(live: ILiveSession): void {
    const slug = this._namingSlug(live);
    const model = live.panel.model;
    if (slug === null || model.writers.length > 0 || this._isDisposed) {
      return;
    }
    live.named = true;
    const from = model.name;
    void (async () => {
      const directory = PathExt.dirname(from);
      const name = await uniqueSessionName(this._contents, directory, slug);
      if (model.writers.length > 0) {
        // Someone started writing while the name was chosen: wait again.
        live.named = false;
        this._scheduleNaming(live);
        return;
      }
      await this._contents.rename(
        from,
        this._contents.resolvePath(
          directory,
          `${name}${SESSION_FILE_EXTENSION}`
        )
      );
    })().catch(error => {
      console.warn(
        'Could not name the session after its first message.',
        error
      );
    });
  }

  /**
   * Remember the session the user works in, and put the cursor back in its
   * composer when closing another tab hands the focus back to it.
   */
  private _onCurrentChanged(
    _shell: ILabShell,
    args: ILabShell.IChangedArgs
  ): void {
    const { oldValue, newValue } = args;
    const session = trackedSession(this._tracker, newValue);
    if (!session) {
      return;
    }
    this._lastSession = session;
    if (oldValue && oldValue.isDisposed) {
      // `currentChanged` fires from the closed widget's `disposed` signal,
      // before the dock panel has switched tabs and moved the focus; a focus
      // set now would be undone. The macrotask runs once the dock is done.
      window.setTimeout(() => {
        if (!session.isDisposed && this._shell.currentWidget === session) {
          this._shell.activateById(session.id);
          session.model.input.focus();
        }
      }, 0);
    }
  }

  /**
   * Follow chat files through the Contents API: a renamed open chat keeps
   * its live state under its new path, and every listing, cached or in
   * flight, of a project whose folder holds the changed file (on the same
   * drive) is marked stale and announced through `changed`.
   */
  private _onFileChanged(
    _contents: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    const oldPath = change.oldValue?.path;
    const newPath = change.newValue?.path;
    const paths = [oldPath, newPath].filter(
      (path): path is string =>
        typeof path === 'string' && path.endsWith(SESSION_FILE_EXTENSION)
    );
    if (!paths.length) {
      return;
    }
    if (change.type === 'rename' && oldPath && newPath) {
      const live = this._live.get(this._contents.localPath(oldPath));
      if (live) {
        this._live.delete(live.path);
        live.path = this._contents.localPath(newPath);
        this._live.set(live.path, live);
      }
    }
    const keys = new Set([...this._listings.keys(), ...this._fetches.keys()]);
    for (const key of keys) {
      if (paths.some(path => isUnderProject(this._contents, key, path))) {
        this._invalidate(key);
      }
    }
  }

  private readonly _commands: CommandRegistry;
  private readonly _shell: JupyterFrontEnd.IShell;
  private readonly _contents: Contents.IManager;
  private readonly _documents: IDocumentManager;
  private readonly _tracker: IChatTracker | null;
  private readonly _labShell: ILabShell | null;
  private readonly _trans: TranslationBundle;
  private readonly _poll: Poll<void, unknown>;
  private readonly _changed = new Signal<this, string>(this);
  private readonly _listings = new Map<string, ICachedListing>();
  private readonly _fetches = new Map<string, IPendingListing>();
  /** How often each project's chats changed, so older requests are not reused. */
  private readonly _versions = new Map<string, number>();
  private readonly _live = new Map<string, ILiveSession>();
  private _lastSession: IChatPanel | null = null;
  private _isDisposed = false;
}
