import type {
  IChatCommandRegistry,
  IChatModel,
  IChatPanel,
  IChatTracker
} from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { PageConfig, PathExt } from '@jupyterlab/coreutils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
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
import { Widget, type DockLayout } from '@lumino/widgets';
import { isRecord } from '../api';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';
import { selectPersona, waitForPersonas } from './persona-registry';
import {
  CHAT_FACTORY,
  CREATE_CHAT_COMMAND,
  ELEMENT_TAB_DATASET_KEY,
  SESSION_TITLE_DATASET_KEY
} from '../workbench-ids';
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
  SESSION_FILE_EXTENSION,
  UNTITLED_SLUG
} from './session-titles';
import {
  fetchProjectAgent,
  listSessions,
  type ISessionInfo,
  type ISessionListing
} from './sessions-api';

export { CHAT_FACTORY, SESSION_TITLE_DATASET_KEY } from '../workbench-ids';

/** PageConfig option the persona manager uses to advertise its default persona. */
const DEFAULT_PERSONA_OPTION = 'jupyter_ai_default_persona';

/** A listing this recent is reused instead of fetched again. */
const LISTING_TTL = 2000;
/**
 * Listings a caller of `list()` asked for this recently are refreshed on
 * every poll tick; older ones are forgotten. The poll's own refreshes do not
 * count as requests.
 */
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
  /** The document manager, which opens chat documents in the main area. */
  documents: IDocumentManager;
  /** Jupyter Chat's panel tracker; null when Jupyter Chat is absent. */
  tracker: IChatTracker | null;
  /** Command providers run before a message is sent, as the composer does. */
  chatCommands: IChatCommandRegistry | null;
  /** The Lab shell, for focus changes; null in other shells. */
  labShell: ILabShell | null;
  /**
   * The server's event stream, carrying persona activity; read only without
   * `registry`, and null to ignore it.
   */
  events: Event.IManager | null;
  /**
   * Jupyter AI's persona session registry, whose per-chat state says whether
   * a persona is processing; null without the persona manager, when the
   * event stream is read instead.
   */
  registry?: PersonaSessionRegistry | null;
  translator?: ITranslator;
}

interface ICachedListing {
  listing: ISessionListing;
  fetchedAt: number;
  /** When a caller of `list()` last asked for this listing. */
  requestedAt: number;
  signature: string;
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
  chatId: string | null;
  entrypoint: Promise<string | null>;
  state: SessionState;
  initialized: boolean;
  /**
   * Whether the chat had a first message when its content loaded; undefined
   * until then. Only a session that gets its first message while open is
   * named after it.
   */
  titledWhenLoaded?: boolean;
  /** The persona manager's state for the chat, when the registry serves one. */
  personaState?: PersonaManagerSessionState;
  onPersonaChanged: () => void;
  disconnect: () => void;
}

/**
 * A session file still called `untitled` in a project's `chats/` folder, the
 * folder the server lists sessions from (`CHATS_DIRECTORY` in `sessions.py`).
 */
const UNTITLED_SESSION = new RegExp(
  `(^|/)chats/${UNTITLED_SLUG}(-\\d+)?${SESSION_FILE_EXTENSION.replace('.', '\\.')}$`
);

/**
 * Whether a session is still named `untitled`: created in `chats/` before its
 * first message was written, as the sidebar and Lightcone Agent create them.
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
 * Whether input metadata carries the persona picker's stamp, which always
 * includes `to_persona` (null for "No one").
 */
export function isComposerStamp(metadata: unknown): boolean {
  return isRecord(metadata) && 'to_persona' in metadata;
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
 * from the composer. It restates `buildMessageMetadata(personaId,
 * emptyPersonaSettings())` of `@jupyter-ai/persona-manager/lib/metadata`,
 * which the package does not export; keep the two in step.
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
    this._documents = options.documents;
    this._tracker = options.tracker;
    this._chatCommands = options.chatCommands;
    this._labShell = options.labShell;
    this._registry = options.registry ?? null;
    this._events = this._registry ? null : options.events;
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
    // The listing names the project's `chats` folder; saving it as a
    // directory creates it when it is missing and leaves it alone otherwise.
    const { directory } = await this._listing(key);
    await this._contents.save(directory, { type: 'directory' });
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
      // Without a choice on Home, the session keeps the project's agent.
      const persona = options.persona || (await this._projectAgent(key));
      await this._sendFirstMessage(panel, message, persona);
    } else if (options.draft) {
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
    this._events?.stream.disconnect(this._onEvent, this);
    this._labShell?.currentChanged.disconnect(this._onCurrentChanged, this);
    this._contents.fileChanged.disconnect(this._onFileChanged, this);
    for (const live of this._live.values()) {
      live.disconnect();
    }
    this._live.clear();
    this._byChatId.clear();
    this._processing.clear();
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

  /**
   * Send the first message the way the composer would: through the chat
   * command providers, then through the input model, addressed to `persona`
   * when the caller chose one and otherwise to the persona the picker
   * selects. A message nobody would receive stays in the composer instead of
   * vanishing.
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
    const available = this._registry
      ? await waitForPersonas(this._registry, panel)
      : undefined;
    const stamped = persona
      ? null
      : this._registry
        ? selectedPersona(model.input.getMetadata())
        : await this._awaitPersonaSelection(model);
    if (panel.isDisposed) {
      return;
    }
    let target =
      persona ||
      stamped ||
      PageConfig.getOption(DEFAULT_PERSONA_OPTION) ||
      null;
    if (this._registry) {
      const listed = available?.personas ?? [];
      if (!listed.some(option => option.id === target)) {
        // An explicit choice is never silently replaced by a different agent.
        // A stale default can yield to the chat's sole available agent.
        target = !persona && listed.length === 1 ? listed[0].id : null;
      }
    }
    model.input.value = message;
    if (!target) {
      model.input.focus();
      Notification.warning(
        this._trans.__(
          'The selected agent is unavailable. Choose an available agent and press Send.'
        ),
        { autoClose: ATTENTION_TOAST_DURATION }
      );
      return;
    }
    if (available && selectedPersona(model.input.getMetadata()) !== target) {
      await this._selectComposerPersona(panel, available, target);
      if (panel.isDisposed) return;
    }
    await this._chatCommands?.onSubmit(model.input);
    // Stamped last: the picker may restamp while the providers run, and
    // `send` snapshots the metadata synchronously, so nothing can overwrite
    // this stamp on the message itself.
    if (selectedPersona(model.input.getMetadata()) !== target) {
      model.input.updateMetadata(personaMetadata(target));
    }
    model.input.send(model.input.value);
    model.input.focus();
  }

  /** Wait for the toolbar to acknowledge selection, including a late mount. */
  private _selectComposerPersona(
    panel: IChatPanel,
    state: PersonaManagerSessionState,
    target: string
  ): Promise<void> {
    return new Promise(resolve => {
      const input = panel.model.input;
      const finish = () => {
        window.clearInterval(retry);
        window.clearTimeout(timeout);
        input.metadataChanged?.disconnect(check);
        panel.disposed.disconnect(finish);
        resolve();
      };
      const check = () => {
        if (selectedPersona(input.getMetadata()) === target) finish();
      };
      // The first metadata stamp can precede the toolbar's subscription to
      // the live registry. Retry until its React effect confirms the choice.
      const retry = window.setInterval(() => {
        if (state.isDisposed) finish();
        else selectPersona(state, target);
      }, 50);
      const timeout = window.setTimeout(finish, COMPOSER_TIMEOUT);
      input.metadataChanged?.connect(check);
      panel.disposed.connect(finish);
      selectPersona(state, target);
      check();
    });
  }

  /**
   * Wait for the persona picker to stamp a chosen persona on the composer,
   * and resolve with it (null after a timeout, when no picker is mounted or
   * it keeps "No one").
   *
   * The picker stamps `to_persona` as soon as its toolbar mounts, but a
   * `to_persona: null` stamp is not final yet: the picker still selects a
   * chat's sole persona once its persona list arrives. Only a chosen persona
   * ends the wait early.
   */
  private _awaitPersonaSelection(model: IChatModel): Promise<string | null> {
    const decided = (metadata: unknown): boolean =>
      isComposerStamp(metadata) && selectedPersona(metadata) !== null;
    const current = model.input.getMetadata();
    if (decided(current)) {
      return Promise.resolve(selectedPersona(current));
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
        const metadata = model.input.getMetadata();
        if (decided(metadata)) {
          finish(selectedPersona(metadata));
        }
      };
      const timer = window.setTimeout(() => finish(null), COMPOSER_TIMEOUT);
      signal.connect(onChange);
    });
  }

  /** The persona the project's messages last went to; undefined when unknown. */
  private async _projectAgent(entrypoint: string): Promise<string | undefined> {
    try {
      return (
        (await fetchProjectAgent(this._contents.serverSettings, entrypoint)) ??
        undefined
      );
    } catch (error) {
      console.warn('Could not read the project agent.', error);
      return undefined;
    }
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
   * Fetch a listing, sharing a request already in flight. It leaves
   * `requestedAt` alone, so the poll's refreshes never keep a listing alive.
   */
  private _refresh(key: string): Promise<ISessionListing> {
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
        await this._refresh(key);
      } catch (error) {
        console.warn('Could not refresh the Lightcone sessions.', error);
      }
    }
  }

  private _onPanelAdded(_tracker: IChatTracker, panel: IChatPanel): void {
    this._track(panel);
  }

  /**
   * Follow the activity of an open chat. A chat already followed through
   * another panel keeps that panel, unless this one is a main-area session
   * and the other is not: then this one takes over. `inherited` is the live
   * state of the panel being replaced; the new panel starts from it, so the
   * handover itself raises no notification.
   */
  private _track(panel: IChatPanel, inherited?: ILiveSession): void {
    if (panel.isDisposed) {
      return;
    }
    const path = this._contents.localPath(panel.model.name);
    const existing = this._live.get(path);
    if (existing) {
      if (
        existing.panel === panel ||
        existing.panel.area === 'main' ||
        panel.area !== 'main'
      ) {
        return;
      }
      this._release(existing);
      inherited = existing;
    }
    const model = panel.model;
    const update = () => this._update(live);
    const onDisposed = () => this._untrack(live);
    const live: ILiveSession = {
      panel,
      path,
      chatId: inherited?.chatId ?? null,
      entrypoint: inherited?.entrypoint ?? this._resolveEntrypoint(path),
      state: inherited?.state ?? 'idle',
      initialized: inherited?.initialized ?? false,
      onPersonaChanged: update,
      disconnect: () => {
        model.writersChanged?.disconnect(update);
        model.messagesUpdated.disconnect(update);
        model.messageChanged.disconnect(update);
        panel.disposed.disconnect(onDisposed);
        live.personaState?.changed.disconnect(live.onPersonaChanged);
        live.personaState = undefined;
      }
    };
    model.writersChanged?.connect(update);
    model.messagesUpdated.connect(update);
    model.messageChanged.connect(update);
    panel.disposed.connect(onDisposed);
    this._live.set(path, live);
    if (live.chatId !== null) {
      this._byChatId.set(live.chatId, live);
    }
    model.ready
      .then(id => {
        if (this._isDisposed || this._live.get(live.path) !== live) {
          return;
        }
        if (
          live.chatId !== null &&
          live.chatId !== id &&
          this._byChatId.get(live.chatId) === live
        ) {
          this._byChatId.delete(live.chatId);
        }
        live.chatId = id;
        this._byChatId.set(id, live);
        live.titledWhenLoaded ??= !!messagesTitle(live.panel.model.messages);
        // Apply persona activity reported before the chat was ready.
        this._update(live);
      })
      .catch(() => undefined);
    // A panel taking over keeps the state it inherited until its own model
    // has loaded the chat: an empty model would read as a finished session.
    if (!inherited) {
      this._update(live);
    }
  }

  /** Stop following a panel, without announcing anything. */
  private _release(live: ILiveSession): void {
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
  }

  /**
   * A followed panel closed. Another open panel of the same chat, e.g. the
   * main-area document Jupyter Chat's "move to the main area" opens before
   * closing the side panel, takes over its state; otherwise the listings fall
   * back to the server's view.
   */
  private _untrack(live: ILiveSession): void {
    this._release(live);
    const successor = this._successor(live);
    if (successor) {
      this._track(successor, live);
    } else {
      this._announce(live);
    }
  }

  /** Another open panel of the chat `live` followed, preferring the main area. */
  private _successor(live: ILiveSession): IChatPanel | undefined {
    const candidates: IChatPanel[] = [];
    this._tracker?.forEach(panel => {
      if (
        panel !== live.panel &&
        !panel.isDisposed &&
        this._contents.localPath(panel.model.name) === live.path
      ) {
        candidates.push(panel);
      }
    });
    return candidates.find(panel => panel.area === 'main') ?? candidates[0];
  }

  private _update(live: ILiveSession): void {
    syncSessionTabTitle(live.panel);
    this._nameAfterFirstMessage(live);
    const model = live.panel.model;
    const next = deriveSessionState({
      messages: model.messages,
      writers: model.writers,
      processing: this._processingIn(live)
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

  /**
   * Whether a persona reports processing a message in the chat: from the
   * persona manager's registry when there is one, else from the personas the
   * event stream reported.
   */
  private _processingIn(live: ILiveSession): boolean {
    if (live.chatId === null) {
      return false;
    }
    const state = this._personaState(live, live.chatId);
    if (state) {
      return state.processing;
    }
    return !!this._processing.get(live.chatId)?.size;
  }

  /**
   * The registry's state for the chat, followed for its changes. The
   * registry discards a chat's state when any view of the chat closes and
   * hands out a fresh one on the next `get`, so the state is looked up on
   * every update and the `changed` connection moves along with it.
   */
  private _personaState(
    live: ILiveSession,
    chatId: string
  ): PersonaManagerSessionState | undefined {
    if (!this._registry) {
      return undefined;
    }
    const state = this._registry.get(chatId);
    if (live.personaState !== state) {
      live.personaState?.changed.disconnect(live.onPersonaChanged);
      live.personaState = state;
      state.changed.connect(live.onPersonaChanged);
    }
    return state;
  }

  /**
   * Name a session created without a message after its first one, as Home
   * names the sessions it starts: `chats/untitled.chat` becomes
   * `chats/<slug of the first line>.chat`. Jupyter Chat and this manager
   * follow the rename; a chat that already had messages when it loaded, or
   * one outside `chats/`, keeps its name.
   */
  private _nameAfterFirstMessage(live: ILiveSession): void {
    if (
      live.titledWhenLoaded !== false ||
      live.panel.area !== 'main' ||
      !isUntitledSession(live.path) ||
      this._naming.has(live.path)
    ) {
      return;
    }
    const title = messagesTitle(live.panel.model.messages);
    const slug = title ? slugForTitle(title) : UNTITLED_SLUG;
    if (slug === UNTITLED_SLUG) {
      return;
    }
    const from = live.panel.model.name;
    const originalPath = live.path;
    this._naming.add(originalPath);
    void (async () => {
      const directory = PathExt.dirname(from);
      const name = await uniqueSessionName(this._contents, directory, slug);
      await this._contents.rename(
        from,
        this._contents.resolvePath(
          directory,
          `${name}${SESSION_FILE_EXTENSION}`
        )
      );
    })()
      .catch(error => {
        console.warn(
          'Could not name the session after its first message.',
          error
        );
      })
      .finally(() => {
        this._naming.delete(originalPath);
      });
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
    return titleForSession({
      path: live.path,
      title: messagesTitle(live.panel.model.messages)
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

  /**
   * Without the persona manager's registry, record which personas report
   * processing a message, per chat id, whether or not a panel of that chat is
   * ready yet: the persona manager re-emits its state when a client connects
   * to a chat, which can arrive before the chat's `ready` resolves.
   */
  private _onEvent(_manager: Event.IManager, emission: Event.Emission): void {
    const event = readPersonaStateEvent(emission);
    if (!event || event.processing === undefined) {
      return;
    }
    let personas = this._processing.get(event.chatId);
    if (event.processing) {
      if (!personas) {
        personas = new Set();
        this._processing.set(event.chatId, personas);
      }
      personas.add(event.personaId);
    } else if (personas) {
      personas.delete(event.personaId);
      if (!personas.size) {
        this._processing.delete(event.chatId);
      }
    }
    const live = this._byChatId.get(event.chatId);
    if (live) {
      this._update(live);
    }
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
   * its live state under its new path, and every cached listing of a project
   * whose folder holds the changed file (on the same drive) is marked stale
   * and announced through `changed`.
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
  private readonly _documents: IDocumentManager;
  private readonly _tracker: IChatTracker | null;
  private readonly _chatCommands: IChatCommandRegistry | null;
  private readonly _labShell: ILabShell | null;
  private readonly _events: Event.IManager | null;
  private readonly _registry: PersonaSessionRegistry | null;
  private readonly _trans: TranslationBundle;
  private readonly _poll: Poll<void, unknown>;
  private readonly _changed = new Signal<this, string>(this);
  private readonly _listings = new Map<string, ICachedListing>();
  private readonly _fetches = new Map<string, Promise<ISessionListing>>();
  private readonly _live = new Map<string, ILiveSession>();
  /** Untitled sessions already being named, by their old local path. */
  private readonly _naming = new Set<string>();
  private readonly _byChatId = new Map<string, ILiveSession>();
  /** Without the registry: personas reporting that they process a message, by chat id. */
  private readonly _processing = new Map<string, Set<string>>();
  private _lastSession: IChatPanel | null = null;
  private _isDisposed = false;
}
