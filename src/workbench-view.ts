import type { ISignal } from '@lumino/signaling';
import { isRecord } from './api';

/**
 * What a workbench view (a record tab or the inventory) tells the
 * sidebar and the tab labeller about itself, without them importing its class.
 */
export interface ILightconeView {
  /** Marks the widget as a workbench view; the typeguard reads it. */
  readonly lightconeView: true;
  /** The Contents path of the project's `astra.yaml`. */
  readonly entrypoint: string;
  /** The record the view shows, for record tabs. */
  readonly reference?: { target: string; doi?: string | null };
  /** The analysis the view shows, when it scopes one. */
  readonly analysisPath?: string;
  /** Emitted when the record or history shown changes. */
  readonly historyChanged?: ISignal<unknown, unknown>;
  /** Emitted when the analysis scope changes. */
  readonly scopeChanged?: ISignal<unknown, unknown>;
}

/** Whether a value is a workbench view, by the brand its class sets. */
export function isLightconeView(value: unknown): value is ILightconeView {
  return (
    isRecord(value) &&
    value.lightconeView === true &&
    typeof value.entrypoint === 'string'
  );
}
