import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import { MainAreaWidget } from '@jupyterlab/apputils';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import { MODE_SETTING_ID, readAgentModes } from './acp-metadata';
import { personaDisplayName } from './session-activity';

/** The toolbar item's name in a session's toolbar. */
export const PERMISSIONS_TOOLBAR_ITEM = 'lightcone-permissions';

/** Root class of the permission item in a session's toolbar. */
export const PERMISSIONS_CLASS = 'jp-jupyterlab-lightcone-SessionPermissions';

/**
 * What the item says about the boundary, so no one mistakes the engine's
 * sandbox for a limit on the agent.
 */
export function boundaryNote(trans: TranslationBundle): string {
  return trans.__(
    'Lightcone’s sandbox (Landlock or Seatbelt) confines the recipes lc run and lc materialize execute. It does not confine the agent’s own shell, which acts with this permission mode.'
  );
}

/** One agent's permission mode, as Jupyter AI records it in the chat. */
export interface IAgentMode {
  persona: string;
  /** The agent's display name. */
  name: string;
  /** The ACP mode, such as `agent-full-access` or `acceptEdits`. */
  mode: string;
}

/**
 * The part of Jupyter Chat's shared document the item reads. `@jupyter/chat`
 * exposes no chat-level metadata on `IChatModel`; the `YChat` of
 * `jupyterlab-chat`, which the workbench does not depend on, has this shape.
 */
export interface ISharedChat {
  getSource(): unknown;
  readonly changed: ISignal<unknown, unknown>;
}

function isSharedChat(value: unknown): value is ISharedChat {
  return (
    isRecord(value) &&
    typeof value.getSource === 'function' &&
    isRecord(value.changed) &&
    typeof value.changed.connect === 'function'
  );
}

/**
 * The modes a chat document records for its ACP personas, from the chat
 * metadata. The display name comes from the chat's users, else the ID's last
 * segment.
 */
export function agentModes(source: unknown): IAgentMode[] {
  if (!isRecord(source)) {
    return [];
  }
  const users = isRecord(source.users) ? source.users : {};
  const modes = readAgentModes(source.metadata).map(({ persona, mode }) => {
    const user = users[persona];
    const named = isRecord(user)
      ? [user.display_name, user.name].find(
          (value): value is string => typeof value === 'string' && !!value
        )
      : undefined;
    return { persona, name: named ?? personaDisplayName(persona), mode };
  });
  return sortModes(modes);
}

/**
 * The modes the persona manager publishes for the chat's personas: the
 * setting the ACP client keys `MODE_SETTING_ID`, shown by its option's name.
 * Empty until a persona has published its state.
 */
export function publishedModes(
  state: PersonaManagerSessionState
): IAgentMode[] {
  const modes: IAgentMode[] = [];
  for (const persona of state.personas) {
    const setting = state
      .getPersona(persona.id)
      ?.settings.find(item => item.id === MODE_SETTING_ID);
    const current = setting?.current;
    if (!current) {
      continue;
    }
    const option = setting.options.find(item => item.id === current);
    modes.push({
      persona: persona.id,
      name: persona.name || personaDisplayName(persona.id),
      mode: option?.name || current
    });
  }
  return sortModes(modes);
}

function sortModes(modes: IAgentMode[]): IAgentMode[] {
  return modes.sort((a, b) => a.name.localeCompare(b.name));
}

/** A mode in words: `agent-full-access` → "agent full access". */
export function modeWords(mode: string): string {
  return mode
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** "Codex: agent full access", one agent after another. */
export function modesText(modes: readonly IAgentMode[]): string {
  return modes.map(item => `${item.name}: ${modeWords(item.mode)}`).join(' · ');
}

export interface ISessionPermissionsOptions {
  /** The chat document, read for the modes no persona has published. */
  shared: ISharedChat;
  /**
   * The persona manager's state for the chat, looked up on every refresh:
   * the registry replaces a chat's state when a view of it closes. Undefined
   * without the persona manager, or before the chat's id is known.
   */
  personas?: () => PersonaManagerSessionState | undefined;
  trans?: TranslationBundle;
}

/**
 * The session header's statement of what the agent may do: its permission
 * mode, and that the engine's sandbox does not bound the agent's shell.
 * Hidden until Jupyter AI records a mode for the chat.
 */
export class SessionPermissions extends Widget {
  constructor(options: ISessionPermissionsOptions) {
    super();
    this._shared = options.shared;
    this._personas = options.personas;
    this._trans = options.trans ?? nullTranslator.load('jupyterlab_lightcone');
    this._note = boundaryNote(this._trans);
    this.addClass(PERMISSIONS_CLASS);
    this._mode = document.createElement('span');
    this._mode.className = `${PERMISSIONS_CLASS}-mode`;
    const note = document.createElement('span');
    note.className = `${PERMISSIONS_CLASS}-note`;
    note.textContent = this._trans.__('sandbox: lc runs only');
    this.node.append(this._mode, note);
    this.node.title = this._note;
    this._shared.changed.connect(this._onSharedChanged, this);
    this.refresh();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._shared.changed.disconnect(this._onSharedChanged, this);
    this._state?.changed.disconnect(this.refresh, this);
    this._state = undefined;
    super.dispose();
  }

  /** Read the modes again, from the persona manager when it has them. */
  refresh(): void {
    if (this.isDisposed) {
      return;
    }
    const state = this._personas?.();
    if (state !== this._state) {
      this._state?.changed.disconnect(this.refresh, this);
      this._state = state;
      state?.changed.connect(this.refresh, this);
    }
    const published = state ? publishedModes(state) : [];
    const modes = published.length
      ? published
      : agentModes(this._shared.getSource());
    const text = modesText(modes);
    this._mode.textContent = text;
    this.node.setAttribute(
      'aria-label',
      text
        ? this._trans.__('Agent permissions: %1. %2', text, this._note)
        : this._note
    );
    this.setHidden(!text);
  }

  /**
   * Only a change of the chat's metadata can change the recorded modes;
   * `YChat.changed` names metadata changes, and `getSource()` copies the
   * whole chat, so every other change is left alone.
   */
  private _onSharedChanged(_sender: unknown, changes: unknown): void {
    if (isRecord(changes) && changes.metadataChanges !== undefined) {
      this.refresh();
    }
  }

  private readonly _shared: ISharedChat;
  private readonly _personas:
    (() => PersonaManagerSessionState | undefined) | undefined;
  private readonly _trans: TranslationBundle;
  private readonly _note: string;
  private readonly _mode: HTMLElement;
  private _state: PersonaManagerSessionState | undefined;
}

export interface ISessionPermissionsHostOptions {
  translator?: ITranslator;
  /** Jupyter AI's persona session registry; null without the persona manager. */
  registry?: PersonaSessionRegistry | null;
}

/**
 * Add the permission item to the toolbar of every main-area session, now and
 * as sessions open; side-panel chats keep Jupyter Chat's own header.
 */
export function addSessionPermissions(
  tracker: IChatTracker,
  options: ISessionPermissionsHostOptions = {}
): IDisposable {
  const trans = (options.translator ?? nullTranslator).load(
    'jupyterlab_lightcone'
  );
  const registry = options.registry ?? null;
  const attach = (panel: IChatPanel) => {
    if (
      panel.area !== 'main' ||
      !(panel instanceof MainAreaWidget) ||
      panel.isDisposed
    ) {
      return;
    }
    const model: unknown = panel.model;
    const sharedModel = isRecord(model) ? model.sharedModel : undefined;
    if (!isSharedChat(sharedModel)) {
      return;
    }
    const names = Array.from(panel.toolbar.names());
    if (names.includes(PERMISSIONS_TOOLBAR_ITEM)) {
      return;
    }
    let chatId: string | null = null;
    const item = new SessionPermissions({
      shared: sharedModel,
      trans,
      personas: registry
        ? () => (chatId === null ? undefined : registry.get(chatId))
        : undefined
    });
    panel.toolbar.addItem(PERMISSIONS_TOOLBAR_ITEM, item);
    if (registry) {
      void panel.model.ready
        .then(id => {
          chatId = id;
          item.refresh();
        })
        .catch(() => undefined);
    }
  };
  tracker.forEach(attach);
  const onAdded = (_tracker: IChatTracker, panel: IChatPanel) => attach(panel);
  tracker.widgetAdded.connect(onAdded);
  let disposed = false;
  return {
    get isDisposed() {
      return disposed;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      tracker.widgetAdded.disconnect(onAdded);
    }
  };
}
