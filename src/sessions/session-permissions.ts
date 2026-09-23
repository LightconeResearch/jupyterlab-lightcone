import type { IChatTracker } from '@jupyter/chat';
import { MainAreaWidget } from '@jupyterlab/apputils';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import { isSessionWidget } from './session-manager';

/** The toolbar item's name in a session's toolbar. */
export const PERMISSIONS_TOOLBAR_ITEM = 'lightcone-permissions';

/** Root class of the permission item in a session's toolbar. */
export const PERMISSIONS_CLASS = 'jp-jupyterlab-lightcone-SessionPermissions';

/**
 * What the item says about the boundary, so no one mistakes the engine's
 * sandbox for a limit on the agent.
 */
export const BOUNDARY_NOTE =
  'Lightcone’s sandbox (Landlock or Seatbelt) confines the recipes lc run and lc materialize execute. It does not confine the agent’s own shell, which acts with this permission mode.';

/** One agent's permission mode, as Jupyter AI records it in the chat. */
export interface IAgentMode {
  persona: string;
  /** The agent's display name. */
  name: string;
  /** The ACP mode ID, such as `agent-full-access` or `acceptEdits`. */
  mode: string;
}

/** The part of Jupyter Chat's shared document the item reads. */
interface ISharedChat {
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
 * The modes a chat document records: Jupyter AI's ACP personas keep them in
 * the chat metadata under `acp_config_options`, keyed by persona ID. The
 * display name comes from the chat's users, else the ID's last segment.
 */
export function agentModes(source: unknown): IAgentMode[] {
  if (!isRecord(source) || !isRecord(source.metadata)) return [];
  const options = source.metadata.acp_config_options;
  if (!isRecord(options)) return [];
  const users = isRecord(source.users) ? source.users : {};
  const modes: IAgentMode[] = [];
  for (const [persona, config] of Object.entries(options)) {
    const mode = isRecord(config) ? config.mode : undefined;
    if (typeof mode !== 'string' || !mode) continue;
    const user = users[persona];
    const named = isRecord(user)
      ? [user.display_name, user.name].find(
          (value): value is string => typeof value === 'string' && !!value
        )
      : undefined;
    modes.push({
      persona,
      name: named ?? persona.split('::').pop() ?? persona,
      mode
    });
  }
  return modes.sort((a, b) => a.name.localeCompare(b.name));
}

/** A mode ID in words: `agent-full-access` → "agent full access". */
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

/**
 * The session header's statement of what the agent may do: its permission
 * mode, and that the engine's sandbox does not bound the agent's shell.
 * Hidden until Jupyter AI records a mode for the chat.
 */
export class SessionPermissions extends Widget {
  constructor(private readonly _shared: ISharedChat) {
    super();
    this.addClass(PERMISSIONS_CLASS);
    this._mode = document.createElement('span');
    this._mode.className = `${PERMISSIONS_CLASS}-mode`;
    this._note = document.createElement('span');
    this._note.className = `${PERMISSIONS_CLASS}-note`;
    this._note.textContent = 'sandbox: lc runs only';
    this.node.append(this._mode, this._note);
    this.node.title = BOUNDARY_NOTE;
    this._shared.changed.connect(this._refresh, this);
    this._refresh();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._shared.changed.disconnect(this._refresh, this);
    super.dispose();
  }

  private _refresh(): void {
    const modes = agentModes(this._shared.getSource());
    const text = modesText(modes);
    this._mode.textContent = text;
    this.node.setAttribute(
      'aria-label',
      text ? `Agent permissions: ${text}. ${BOUNDARY_NOTE}` : BOUNDARY_NOTE
    );
    this.setHidden(!text);
  }

  private readonly _mode: HTMLElement;
  private readonly _note: HTMLElement;
}

/**
 * Add the permission item to the toolbar of every main-area session, now and
 * as sessions open; side-panel chats keep Jupyter Chat's own header.
 */
export function addSessionPermissions(tracker: IChatTracker): IDisposable {
  const attach = (panel: unknown) => {
    if (
      !isSessionWidget(panel) ||
      !(panel instanceof MainAreaWidget) ||
      panel.isDisposed
    )
      return;
    const model: unknown = panel.model;
    const sharedModel = isRecord(model) ? model.sharedModel : undefined;
    if (!isSharedChat(sharedModel)) return;
    const names = Array.from(panel.toolbar.names());
    if (names.includes(PERMISSIONS_TOOLBAR_ITEM)) return;
    panel.toolbar.addItem(
      PERMISSIONS_TOOLBAR_ITEM,
      new SessionPermissions(sharedModel)
    );
  };
  tracker.forEach(attach);
  const onAdded = (_tracker: IChatTracker, panel: unknown) => attach(panel);
  tracker.widgetAdded.connect(onAdded);
  let disposed = false;
  return {
    get isDisposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tracker.widgetAdded.disconnect(onAdded);
    }
  };
}
