import { isRecord } from './api';

/**
 * What a workbench view (a record tab, the inventory, or the pipeline) tells
 * the tab labeller about itself, without it importing the view's class.
 */
export interface ILightconeView {
  /** Marks the widget as a workbench view; the typeguard reads it. */
  readonly lightconeView: true;
  /** The Contents path of the project's `astra.yaml`. */
  readonly entrypoint: string;
}

/** Whether a value is a workbench view, by the brand its class sets. */
export function isLightconeView(value: unknown): value is ILightconeView {
  return (
    isRecord(value) &&
    value.lightconeView === true &&
    typeof value.entrypoint === 'string'
  );
}
