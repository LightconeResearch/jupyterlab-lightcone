import { MainAreaWidget } from '@jupyterlab/apputils';
import { DocumentWidget } from '@jupyterlab/docregistry';
import type { ISignal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import { isSessionWidget } from '../sessions/session-manager';
import { isLightconeView, type ILightconeView } from '../workbench-view';

/** Which Lightcone view a main-area widget shows, when it shows one. */
export interface ICurrentView {
  /** Contents path of the chat document that is current. */
  session?: string;
  /** The record tab that is current. */
  record?: { entrypoint: string; target: string; doi?: string };
  /** The inventory document that is current, as its entrypoint. */
  inventory?: string;
  /** The analysis that inventory shows, once it has loaded. */
  analysisPath?: string;
}

/**
 * The workbench view a main-area widget is, or wraps: the inventory document
 * states its view itself, a record tab through the content of its
 * `MainAreaWidget`.
 */
function lightconeView(widget: Widget): ILightconeView | undefined {
  if (isLightconeView(widget)) {
    return widget;
  }
  if (widget instanceof MainAreaWidget && isLightconeView(widget.content)) {
    return widget.content;
  }
  return undefined;
}

/**
 * Describe the current widget, so the sidebar can highlight a session, a
 * record tab or the inventory and its scope: sessions are Jupyter Chat's
 * main-area panels, the other views state themselves (`ILightconeView`). A
 * view showing a record is a record tab; one scoping an analysis is the
 * inventory.
 */
export function describeWidget(widget: Widget | null): ICurrentView {
  if (!widget) {
    return {};
  }
  if (isSessionWidget(widget)) {
    return { session: widget.model.name };
  }
  const view = lightconeView(widget);
  if (!view) {
    return {};
  }
  if (view.reference) {
    const { target, doi } = view.reference;
    return {
      record: { entrypoint: view.entrypoint, target, ...(doi ? { doi } : {}) }
    };
  }
  if (view.scopeChanged) {
    const scope = view.analysisPath;
    return {
      inventory: view.entrypoint,
      ...(scope !== undefined ? { analysisPath: scope } : {})
    };
  }
  return {};
}

/**
 * The signals after which a widget shows another view while it stays the
 * current widget: a document renamed under it (its context's
 * `pathChanged`), a record tab following a link (`historyChanged`) and an
 * inventory moving to another analysis (`scopeChanged`).
 */
export function viewChanges(
  widget: Widget | null
): ISignal<unknown, unknown>[] {
  if (!widget) {
    return [];
  }
  const signals: ISignal<unknown, unknown>[] = [];
  if (widget instanceof DocumentWidget) {
    signals.push(widget.context.pathChanged);
  }
  const view = lightconeView(widget);
  if (view?.historyChanged) {
    signals.push(view.historyChanged);
  }
  if (view?.scopeChanged) {
    signals.push(view.scopeChanged);
  }
  return signals;
}
