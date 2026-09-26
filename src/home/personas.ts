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
    Array.isArray(emission.personas)
  );
}

/**
 * Merge a `personas` event into the known personas. Returns undefined for any
 * other event, and a new list only when the event adds or renames a persona,
 * so callers can compare references.
 */
export function mergePersonas(
  current: readonly IPersonaOption[],
  emission: unknown
): IPersonaOption[] | undefined {
  if (!isPersonasEvent(emission)) {
    return undefined;
  }
  const merged = new Map(current.map(persona => [persona.id, persona.name]));
  let changed = false;
  for (const entry of emission.personas) {
    if (!isPersonaOption(entry)) {
      continue;
    }
    if (merged.get(entry.id) !== entry.name) {
      merged.set(entry.id, entry.name);
      changed = true;
    }
  }
  if (!changed) {
    return undefined;
  }
  return [...merged].map(([id, name]) => ({ id, name }));
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
 * The personas the persona manager has advertised in this session. The
 * manager publishes them per chat, only once a chat is open; lists from
 * several chats are merged. Home refreshes its agent discovery whenever a
 * list adds or renames a persona.
 */
export class PersonaDirectory implements IDisposable {
  constructor(events: Event.IManager) {
    this._events = events;
    events.stream.connect(this._onEmission, this);
  }

  /** Known personas, in the order they were first seen. */
  get personas(): readonly IPersonaOption[] {
    return this._personas;
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
    this._events.stream.disconnect(this._onEmission, this);
    Signal.clearData(this);
  }

  private _onEmission(_sender: Event.IManager, emission: Event.Emission): void {
    const merged = mergePersonas(this._personas, emission);
    if (!merged) {
      return;
    }
    this._personas = merged;
    this._changed.emit();
  }

  private _events: Event.IManager;
  private _personas: IPersonaOption[] = [];
  private _changed = new Signal<this, void>(this);
  private _isDisposed = false;
}
