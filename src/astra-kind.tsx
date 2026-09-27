import type { SurfaceKind } from '@astra-spec/ui/model';
import { KindGlyph } from '@astra-spec/ui/primitives';
import type { IThemeManager } from '@jupyterlab/apputils';
import type { IDisposable } from '@lumino/disposable';
import type { VirtualElement } from '@lumino/virtualdom';
import React, { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { colorScheme, type ColorScheme } from './theme-adapter';

/**
 * The classes of a kind mark's root: the Lightcone ASTRA theme's scope, which
 * supplies the kind colours, and the host class that keeps it inline.
 */
const KIND_MARK_CLASS =
  'lightcone-brand astra-ui jp-jupyterlab-lightcone-KindMark';

type ThemeManager = Pick<IThemeManager, 'theme' | 'isLight' | 'themeChanged'>;

/**
 * The Lab's colour scheme, as the theme manager last reported it. Kind marks
 * are drawn in many components that are not handed the manager, so one plugin
 * binds the store to it (`bindLabColorScheme`) and every mark reads it here.
 * Before a manager is bound the scheme is light.
 */
let scheme: ColorScheme = 'light';
const listeners = new Set<() => void>();
let binding: IDisposable | null = null;

export function labColorScheme(): ColorScheme {
  return scheme;
}

function publish(next: ColorScheme): void {
  if (next === scheme) return;
  scheme = next;
  listeners.forEach(notify => notify());
}

/**
 * Follow the Lab theme through the public `IThemeManager`: the store takes
 * the manager's verdict now and on every `themeChanged`. Binding again
 * replaces the earlier binding. Returns a disposable that stops following.
 */
export function bindLabColorScheme(manager: ThemeManager): IDisposable {
  binding?.dispose();
  const sync = () => publish(colorScheme(manager));
  manager.themeChanged.connect(sync);
  sync();
  let disposed = false;
  const current: IDisposable = {
    get isDisposed() {
      return disposed;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      manager.themeChanged.disconnect(sync);
      if (binding === current) binding = null;
    }
  };
  binding = current;
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The Lab's current colour scheme, re-rendering when the theme changes. */
export function useLabColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, labColorScheme, () => 'light');
}

export interface IAstraKindMarkProps {
  /** The record kind: `output`, `decision`, `input`, `finding`, `prior_insight`, `analysis` or `paper`. */
  kind: SurfaceKind;
  className?: string;
}

/**
 * The record-kind mark ASTRA views draw (◇ decisions, ▤ inputs, …), in the
 * Lightcone ASTRA theme's kind colours, so every Lightcone surface marks
 * records exactly as the inventory does. The brand scope carries only the
 * kind tokens here; size, background and font come from the surrounding UI.
 * Every `.astra-ui` element takes its palette from its own scheme attribute,
 * so each mark stamps the scheme itself.
 */
export function AstraKindMark({
  kind,
  className
}: IAstraKindMarkProps): React.ReactElement {
  const current = useLabColorScheme();
  return (
    <span
      className={`${KIND_MARK_CLASS}${className ? ` ${className}` : ''}`}
      data-lightcone-color-scheme={current}
      data-astra-color-scheme={current}
    >
      <KindGlyph kind={kind} />
    </span>
  );
}

/** A host can be reused by Lumino with a new kind's renderer. */
const markRoots = new WeakMap<HTMLElement, Root>();

/**
 * Render the shared React kind mark through Lumino's public custom-renderer
 * lifecycle. The caller keys the icon host so switching to another renderer
 * removes it, and clears its virtual DOM before disposing the containing widget.
 */
export function kindMarkRenderer(kind: SurfaceKind): VirtualElement.IRenderer {
  return {
    render: (host: HTMLElement) => {
      let root = markRoots.get(host);
      if (!root) {
        root = createRoot(host);
        markRoots.set(host, root);
      }
      root.render(<AstraKindMark kind={kind} />);
    },
    unrender: (host: HTMLElement) => {
      markRoots.get(host)?.unmount();
      markRoots.delete(host);
    }
  };
}
