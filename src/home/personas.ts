import type {
  PERSONAS_EVENT_SCHEMA_ID as UpstreamPersonasId,
  PersonaOption
} from '@jupyter-ai/persona-manager';
import type { Event } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { isRecord } from '../api';

/**
 * The schema Jupyter AI's persona manager uses to advertise a chat's personas
 * over the Jupyter Events bus. The persona manager is only type-imported (it
 * is a shared singleton, not bundled), so the id is spelled here and pinned
 * to the upstream constant's literal type: a renamed id fails to compile
 * instead of emptying the picker.
 */
export const PERSONAS_EVENT_SCHEMA_ID: typeof UpstreamPersonasId =
  'https://schema.jupyter.org/jupyter_ai_persona_manager/personas/v1';

/** One agent persona the composer can address, as the manager advertises it. */
export type IPersonaOption = Pick<PersonaOption, 'id' | 'name'>;

function isPersonaOption(value: unknown): value is IPersonaOption {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string'
  );
}

/** Whether an event is the persona manager's list of a chat's personas. */
function isPersonasEvent(
  emission: unknown
): emission is { personas: unknown[] } {
  return (
    isRecord(emission) &&
    emission.schema_id === PERSONAS_EVENT_SCHEMA_ID &&
    Array.isArray(emission.personas) &&
    emission.personas.every(isPersonaOption)
  );
}

/**
 * The persona a composer draft addresses: its saved choice while the directory
 * still lists it, the chat's default (an empty id) otherwise. A persona that is
 * no longer advertised must not override the default the picker displays.
 */
export function knownPersona(
  personas: readonly IPersonaOption[],
  id: string
): string {
  return personas.some(persona => persona.id === id) ? id : '';
}

/**
 * Notify Home when a chat advertises personas, including removals and avatar
 * changes. The project discovery route owns the list; a second merged catalog
 * would retain removed choices. Coalesce bursts from restored chats before
 * Home discovers its current project's agents again.
 */
export class PersonaDirectory implements IDisposable {
  constructor(events: Event.IManager) {
    this._events = events;
    events.stream.connect(this._onEmission, this);
  }

  /** Emitted when the known personas change. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    window.clearTimeout(this._timer);
    this._events.stream.disconnect(this._onEmission, this);
    Signal.clearData(this);
  }

  private _onEmission(_sender: Event.IManager, emission: Event.Emission): void {
    if (!isPersonasEvent(emission)) return;
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this._changed.emit(), 100);
  }

  private _events: Event.IManager;
  private _timer: number | undefined;
  private _changed = new Signal<this, void>(this);
  private _isDisposed = false;
}
