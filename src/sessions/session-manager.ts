import type {
  IChatCommandRegistry,
  IChatModel,
  IChatPanel,
  IChatTracker
} from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import type { Contents, Event } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { Signal, type ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';
import {
  activityTransition,
  deriveSessionState,
  isPersonaUser,
  listActivity,
  readPersonaStateEvent,
  type ActivityTransition
} from './session-activity';
import type {
  ISessionService,
  ISessionStartOptions,
  SessionState
} from './session-service';
import {
  slugForTitle,
  titleForSession,
  titleFromMessage,
  uniqueSessionName,
  SESSION_FILE_EXTENSION
} from './session-titles';
import {
  listSessions,
  prepareSessions,
  type ISessionInfo,
  type ISessionListing
} from './sessions-api';

/** Jupyter Chat's document factory for `.chat` files. */
export const CHAT_FACTORY = 'Chat';
const CREATE_CHAT_COMMAND = 'jupyterlab-chat:create';
const OPEN_DOCUMENT_COMMAND = 'docmanager:open';
/** Title data attribute that record tabs carry (see `element-widget.tsx`). */
const RECORD_TAB_DATASET_KEY = 'lightcone-element';
/** PageConfig option the persona manager uses to advertise its default persona. */
const DEFAULT_PERSONA_OPTION = 'jupyter_ai_default_persona';

/** A listing this recent is reused instead of fetched again. */
const LISTING_TTL = 2000;
/** Listings requested this recently are refreshed on every poll tick. */
const ACTIVE_WINDOW = 10 * 60 * 1000;
const POLL_INTERVAL = 15000;
/** How long the first message waits for the composer to choose a persona. */
const COMPOSER_TIMEOUT = 5000;
const FINISHED_TOAST_DURATION = 8000;
const ATTENTION_TOAST_DURATION = 15000;

/** Dependencies of the session manager, narrowed for testing. */
export interface ISessionManagerOptions {
  commands: CommandRegistry;
  shell: JupyterFrontEnd.IShell;
  contents: Contents.IManager;
  /** Jupyter Chat's panel tracker; null when Jupyter Chat is absent. */
  tracker: IChatTracker | null;
  /** Command providers run before a message is sent, as the composer does. */
  chatCommands: IChatCommandRegistry | null;
  /** The Lab shell, for focus changes; null in other shells. */
  labShell: ILabShell | null;
  /** The server's event stream, carrying persona activity; null to ignore it. */
  events: Event.IManager | null;
  translator?: ITranslator;
}

interface ICachedListing {
  listing: ISessionListing;
  fetchedAt: number;
  requestedAt: number;
  signature: string;
}

interface ILiveSession {
  panel: IChatPanel;
  /** Local Contents path of the chat file, the key of `_live`. */
  path: string;
  chatId: string | null;
  entrypoint: Promise<string | null>;
  /** Personas that currently report processing a message in this chat. */
  processing: Set<string>;
  state: SessionState;
  initialized: boolean;
  disconnect: () => void;
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

/** Whether a widget is one of Jupyter Chat's panels, wherever it is shown. */
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

/** Whether a widget is a record tab, which results open beside sessions in. */
export function isRecordTab(widget: Widget): boolean {
  return widget.title.dataset[RECORD_TAB_DATASET_KEY] !== undefined;
}

/** The persona the composer would stamp on the next message, if it chose one. */
export function selectedPersona(metadata: unknown): string | null {
  return isRecord(metadata) &&
    typeof metadata.to_persona === 'string' &&
    metadata.to_persona
    ? metadata.to_persona
    : null;
}

/**
 * The metadata the persona picker stamps for a persona with every control at
 * its default, so a message addressed by the workbench reads like one sent
 * from the composer.
 */
export function personaMetadata(personaId: string): Record<string, unknown> {
  return {
    to_persona: personaId,
    model: { id: null, settings: {} },
    settings: {}
  };
}

/**
 * Project-scoped sessions: lists them through the server, opens them as
 * main-area chat documents, follows the activity of open chats and tells the
 * user when a session they are not looking at finishes or needs them.
 */
export class SessionManager implements ISessionService, IDisposable {
  constructor(options: ISessionManagerOptions) {
    this._commands = options.commands;
    this._shell = options.shell;
    this._contents = options.contents;
    this._tracker = options.tracker;
    this._chatCommands = options.chatCommands;
    this._labShell = options.labShell;
    this._events = options.events;
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this._tracker?.forEach(panel => this._track(panel));
    this._tracker?.widgetAdded.connect(this._onPanelAdded, this);
    this._events?.stream.connect(this._onEvent, this);
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

  /** The sessions of a project, with live activity for the open ones. */
  async list(entrypoint: string): Promise<ISessionInfo[]> {
    const listing = await this._listing(entrypoint);
    return listing.sessions.map(info => {
      const live = this.activity(info.path);
      return live === undefined
        ? info
        : { ...info, activity: listActivity(live) };
    });
  }

  activity(path: string): SessionState | undefined {
    return this._live.get(this._contents.localPath(path))?.state;
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
    const { directory } = await prepareSessions(
      this._contents.serverSettings,
      key
    );
    const title =
      options.title?.trim() || titleFromMessage(options.firstMessage ?? '');
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
    const message = options.firstMessage?.trim() ?? '';
    if (message) {
      await this._sendFirstMessage(panel, message, options.persona);
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
    this._events?.stream.disconnect(this._onEvent, this);
    this._labShell?.currentChanged.disconnect(this._onCurrentChanged, this);
    this._contents.fileChanged.disconnect(this._onFileChanged, this);
    for (const live of this._live.values()) {
      live.disconnect();
    }
    this._live.clear();
    this._byChatId.clear();
    this._listings.clear();
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
    const ref = this._placementRef();
    const opened: unknown = await this._commands.execute(
      OPEN_DOCUMENT_COMMAND,
      {
        path,
        factory: CHAT_FACTORY,
        options: { mode: 'tab-after', activate: true, ...(ref ? { ref } : {}) }
      }
    );
    const panel = isSessionWidget(opened) ? opened : this._findPanel(path);
    if (!panel) {
      throw new Error(
        this._trans.__(
          'The session did not open. Check that Jupyter AI is enabled.'
        )
      );
    }
    return panel;
  }

  /**
   * Sessions join the group of the current document, so they take the main
   * stage while Home or the previous session stays one tab away. From a
   * result tab, they join the session the result was opened beside instead of
   * the result column.
   */
  private _placementRef(): string | undefined {
    const current = this._shell.currentWidget;
    if (!current) {
      return undefined;
    }
    if (isRecordTab(current)) {
      const session = this._lastSession;
      if (session && !session.isDisposed && this._inMainArea(session)) {
        return session.id;
      }
    }
    return current.id;
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
        isSessionWidget(panel) &&
        this._contents.localPath(panel.model.name) === local
    );
  }

  /**
   * Send the first message the way the composer would: after the persona
   * picker has stamped its selection, through the chat command providers,
   * then through the input model. A message nobody would receive stays in
   * the composer instead of vanishing.
   */
  private async _sendFirstMessage(
    panel: IChatPanel,
    message: string,
    persona: string | undefined
  ): Promise<void> {
    const model = panel.model;
    await model.ready;
    if (panel.isDisposed) {
      return;
    }
    const stamped = await this._awaitPersonaSelection(model);
    if (panel.isDisposed) {
      return;
    }
    const target =
      persona ||
      stamped ||
      PageConfig.getOption(DEFAULT_PERSONA_OPTION) ||
      null;
    if (target && target !== stamped) {
      model.input.updateMetadata(personaMetadata(target));
    }
    model.input.value = message;
    if (!target) {
      model.input.focus();
      Notification.warning(
        this._trans.__(
          'No agent is selected for this session. Choose one and press Send.'
        ),
        { autoClose: ATTENTION_TOAST_DURATION }
      );
      return;
    }
    await this._chatCommands?.onSubmit(model.input);
    model.input.send(model.input.value);
    model.input.focus();
  }

  /** The persona the composer stamps once its toolbar mounts, or null after a timeout. */
  private _awaitPersonaSelection(model: IChatModel): Promise<string | null> {
    const current = selectedPersona(model.input.getMetadata());
    if (current) {
      return Promise.resolve(current);
    }
    const signal = model.input.metadataChanged;
    if (!signal) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>(resolve => {
      const finish = (value: string | null) => {
        window.clearTimeout(timer);
        signal.disconnect(onChange);
        resolve(value);
      };
      const onChange = () => {
        const selected = selectedPersona(model.input.getMetadata());
        if (selected) {
          finish(selected);
        }
      };
      const timer = window.setTimeout(() => finish(null), COMPOSER_TIMEOUT);
      signal.connect(onChange);
    });
  }

  private async _listing(
    entrypoint: string,
    force = false
  ): Promise<ISessionListing> {
    const key = this._contents.normalize(entrypoint);
    const cached = this._listings.get(key);
    const now = Date.now();
    if (cached) {
      cached.requestedAt = now;
      if (!force && now - cached.fetchedAt < LISTING_TTL) {
        return cached.listing;
      }
    }
    let pending = this._fetches.get(key);
    if (!pending) {
      pending = this._fetch(key).finally(() => {
        this._fetches.delete(key);
      });
      this._fetches.set(key, pending);
    }
    return pending;
  }

  private async _fetch(key: string): Promise<ISessionListing> {
    const listing = await listSessions(this._contents.serverSettings, key);
    if (this._isDisposed) {
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

  private _invalidate(key: string): void {
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
        await this._listing(key, true);
      } catch (error) {
        console.warn('Could not refresh the Lightcone sessions.', error);
      }
    }
  }

  private _onPanelAdded(_tracker: IChatTracker, panel: IChatPanel): void {
    this._track(panel);
  }

  private _track(panel: IChatPanel): void {
    if (panel.isDisposed || !isChatPanel(panel)) {
      return;
    }
    const path = this._contents.localPath(panel.model.name);
    if (this._live.has(path)) {
      return;
    }
    const model = panel.model;
    const update = () => this._update(live);
    const onDisposed = () => this._untrack(live);
    const live: ILiveSession = {
      panel,
      path,
      chatId: null,
      entrypoint: this._resolveEntrypoint(path),
      processing: new Set(),
      state: 'idle',
      initialized: false,
      disconnect: () => {
        model.writersChanged?.disconnect(update);
        model.messagesUpdated.disconnect(update);
        model.messageChanged.disconnect(update);
        panel.disposed.disconnect(onDisposed);
      }
    };
    model.writersChanged?.connect(update);
    model.messagesUpdated.connect(update);
    model.messageChanged.connect(update);
    panel.disposed.connect(onDisposed);
    this._live.set(path, live);
    model.ready
      .then(id => {
        if (!this._isDisposed && this._live.get(live.path) === live) {
          live.chatId = id;
          this._byChatId.set(id, live);
        }
      })
      .catch(() => undefined);
    this._update(live);
  }

  private _untrack(live: ILiveSession): void {
    live.disconnect();
    if (this._live.get(live.path) === live) {
      this._live.delete(live.path);
    }
    if (live.chatId !== null && this._byChatId.get(live.chatId) === live) {
      this._byChatId.delete(live.chatId);
    }
    if (this._lastSession === live.panel) {
      this._lastSession = null;
    }
    this._announce(live);
  }

  private _update(live: ILiveSession): void {
    const model = live.panel.model;
    const next = deriveSessionState({
      messages: model.messages,
      writers: model.writers,
      processing: live.processing.size > 0
    });
    if (live.initialized && next === live.state) {
      return;
    }
    const transition = activityTransition(
      live.initialized ? live.state : undefined,
      next
    );
    live.state = next;
    live.initialized = true;
    if (transition) {
      this._notify(live, transition);
    }
    this._announce(live);
  }

  private _announce(live: ILiveSession): void {
    void live.entrypoint.then(entrypoint => {
      if (entrypoint !== null && !this._isDisposed) {
        this._changed.emit(entrypoint);
      }
    });
  }

  /** Tell the user about a session they are not looking at. */
  private _notify(live: ILiveSession, transition: ActivityTransition): void {
    const watching =
      this._shell.currentWidget === live.panel &&
      document.visibilityState === 'visible' &&
      document.hasFocus();
    if (watching) {
      return;
    }
    const title = this._liveTitle(live);
    const path = live.path;
    const actions: Notification.IAction[] = [
      {
        label: this._trans.__('Open session'),
        callback: () => {
          this.openSession(path).catch(error => {
            console.warn('Could not open the Lightcone session.', error);
          });
        }
      }
    ];
    if (transition === 'finished') {
      Notification.info(this._trans.__('%1 finished', title), {
        actions,
        autoClose: FINISHED_TOAST_DURATION
      });
    } else {
      Notification.warning(this._trans.__('%1 needs your input', title), {
        actions,
        autoClose: ATTENTION_TOAST_DURATION
      });
    }
  }

  /** The title the server would give this chat, computed from its messages. */
  private _liveTitle(live: ILiveSession): string {
    for (const cached of this._listings.values()) {
      const listed = cached.listing.sessions.find(
        info => this._contents.localPath(info.path) === live.path
      );
      if (listed) {
        return titleForSession(listed);
      }
    }
    const first = live.panel.model.messages.find(
      message => !isPersonaUser(message.sender) && message.body.trim()
    );
    return titleForSession({
      path: live.path,
      title: first ? titleFromMessage(first.body) : ''
    });
  }

  private _resolveEntrypoint(path: string): Promise<string | null> {
    let directory: string;
    try {
      directory = projectDirectory(path);
    } catch {
      return Promise.resolve(null);
    }
    return findProjectRoot(this._contents, directory)
      .then(root => root?.entrypoint ?? null)
      .catch(() => null);
  }

  private _onEvent(_manager: Event.IManager, emission: Event.Emission): void {
    const event = readPersonaStateEvent(emission);
    if (!event || event.processing === undefined) {
      return;
    }
    const live = this._byChatId.get(event.chatId);
    if (!live) {
      return;
    }
    if (event.processing) {
      live.processing.add(event.personaId);
    } else {
      live.processing.delete(event.personaId);
    }
    this._update(live);
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
    if (!isSessionWidget(newValue)) {
      return;
    }
    this._lastSession = newValue;
    if (oldValue && oldValue.isDisposed) {
      window.setTimeout(() => {
        if (!newValue.isDisposed && this._shell.currentWidget === newValue) {
          this._shell.activateById(newValue.id);
          newValue.model.input.focus();
        }
      }, 0);
    }
  }

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
        live.entrypoint = this._resolveEntrypoint(live.path);
        this._live.set(live.path, live);
      }
    }
    for (const [key, cached] of this._listings) {
      const drive = this._contents.driveName(key);
      const root = this._contents.localPath(projectDirectory(key));
      const affected = paths.some(path => {
        if (this._contents.driveName(path) !== drive) {
          return false;
        }
        const local = this._contents.localPath(path);
        return !root || local === root || local.startsWith(`${root}/`);
      });
      if (affected) {
        cached.fetchedAt = 0;
        this._changed.emit(key);
      }
    }
  }

  private readonly _commands: CommandRegistry;
  private readonly _shell: JupyterFrontEnd.IShell;
  private readonly _contents: Contents.IManager;
  private readonly _tracker: IChatTracker | null;
  private readonly _chatCommands: IChatCommandRegistry | null;
  private readonly _labShell: ILabShell | null;
  private readonly _events: Event.IManager | null;
  private readonly _trans: TranslationBundle;
  private readonly _poll: Poll<void, unknown>;
  private readonly _changed = new Signal<this, string>(this);
  private readonly _listings = new Map<string, ICachedListing>();
  private readonly _fetches = new Map<string, Promise<ISessionListing>>();
  private readonly _live = new Map<string, ILiveSession>();
  private readonly _byChatId = new Map<string, ILiveSession>();
  private _lastSession: IChatPanel | null = null;
  private _isDisposed = false;
}
