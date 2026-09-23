import type { Event } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { isRecord } from '../api';

/**
 * The schema Jupyter AI's persona manager uses to advertise a chat's personas
 * over the Jupyter Events bus.
 */
export const PERSONAS_EVENT_SCHEMA_ID =
  'https://schema.jupyter.org/jupyter_ai_persona_manager/personas/v1';

/** One agent persona the composer can address. */
export interface IPersonaOption {
  id: string;
  name: string;
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
  if (
    !isRecord(emission) ||
    emission.schema_id !== PERSONAS_EVENT_SCHEMA_ID ||
    !Array.isArray(emission.personas)
  ) {
    return undefined;
  }
  const merged = new Map(current.map(persona => [persona.id, persona.name]));
  let changed = false;
  for (const entry of emission.personas) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.name !== 'string'
    ) {
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
 * The personas the persona manager has advertised in this browser session.
 * Personas are published per chat when it opens, so the list fills as chats
 * open and stays available for Home's agent picker afterwards.
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

  /** Emitted when a persona is added or renamed. */
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
    if (merged) {
      this._personas = merged;
      this._changed.emit();
    }
  }

  private _events: Event.IManager;
  private _personas: IPersonaOption[] = [];
  private _changed = new Signal<this, void>(this);
  private _isDisposed = false;
}
