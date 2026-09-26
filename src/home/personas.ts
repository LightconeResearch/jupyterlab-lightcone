import type {
  PERSONAS_EVENT_SCHEMA_ID as UpstreamPersonasId,
  PersonaOption
} from '@jupyter-ai/persona-manager';
import type { Event } from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
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

/** The state database key keeping the last advertised personas across reloads. */
export const PERSONAS_STATE_KEY = 'jupyterlab_lightcone:home:personas';

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

/** Read a persona list saved in the state database; anything else is empty. */
export function parsePersonas(value: unknown): IPersonaOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const entry of value) {
    if (isPersonaOption(entry) && !seen.has(entry.id)) {
      seen.set(entry.id, entry.name);
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
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
 * The personas the persona manager has advertised. The manager publishes them
 * per chat, only once a chat is open, so the last list seen is kept in the
 * state database: after a reload, Home's agent picker starts from it before
 * any chat is open. The first live list replaces that remembered one, so a
 * persona removed from the server leaves the picker as soon as a chat opens;
 * later lists from other chats are merged into it.
 */
export class PersonaDirectory implements IDisposable {
  constructor(events: Event.IManager, state: IStateDB | null = null) {
    this._events = events;
    this._state = state;
    events.stream.connect(this._onEmission, this);
    if (state) {
      void state
        .fetch(PERSONAS_STATE_KEY)
        .then(value => this._restore(parsePersonas(value)))
        .catch(error => {
          console.warn('Could not restore the known agent personas.', error);
        });
    }
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

  /** Adopt the remembered list unless a live one has already arrived. */
  private _restore(remembered: IPersonaOption[]): void {
    if (this._isDisposed || this._live || !remembered.length) {
      return;
    }
    this._personas = remembered;
    this._changed.emit();
  }

  private _onEmission(_sender: Event.IManager, emission: Event.Emission): void {
    if (!isPersonasEvent(emission)) {
      return;
    }
    // The first live list replaces the remembered one even when it is empty:
    // the manager publishes it once its personas are loaded, so an empty list
    // means the server has none left to offer.
    const merged = this._live
      ? mergePersonas(this._personas, emission)
      : (mergePersonas([], emission) ?? []);
    this._live = true;
    if (!merged || samePersonas(merged, this._personas)) {
      return;
    }
    this._personas = merged;
    this._changed.emit();
    void this._state
      ?.save(
        PERSONAS_STATE_KEY,
        merged.map(({ id, name }) => ({ id, name }))
      )
      .catch(error => {
        console.warn('Could not remember the known agent personas.', error);
      });
  }

  private _events: Event.IManager;
  private _state: IStateDB | null;
  private _personas: IPersonaOption[] = [];
  /** Whether the list comes from this session's events rather than the state database. */
  private _live = false;
  private _changed = new Signal<this, void>(this);
  private _isDisposed = false;
}

function samePersonas(
  a: readonly IPersonaOption[],
  b: readonly IPersonaOption[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (persona, index) =>
        persona.id === b[index].id && persona.name === b[index].name
    )
  );
}
