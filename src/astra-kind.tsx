import { surfaceGlyph, type SurfaceKind } from '@astra-spec/ui/model';
import { KindGlyph } from '@astra-spec/ui/primitives';
import type { IThemeManager } from '@jupyterlab/apputils';
import type { IDisposable } from '@lumino/disposable';
import type { VirtualElement } from '@lumino/virtualdom';
import React, { useSyncExternalStore } from 'react';
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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * The paper mark is the one kind `KindGlyph` draws as an inline SVG rather
 * than as `surfaceGlyph` text, and ASTRA UI exports no plain-DOM form of it.
 * Its drawing is restated here; `astra-kind.spec.tsx` checks that the two
 * still agree.
 */
const PAPER_GLYPH_ATTRIBUTES: Readonly<Record<string, string>> = {
  viewBox: '0 0 24 24',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.6',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  focusable: 'false'
};
const PAPER_GLYPH_PATHS: readonly string[] = [
  'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z',
  'M14 3v5h5M8 12h8M8 16h6'
];

function paperGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  for (const [name, value] of Object.entries(PAPER_GLYPH_ATTRIBUTES)) {
    svg.setAttribute(name, value);
  }
  for (const d of PAPER_GLYPH_PATHS) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * `KindGlyph`'s markup for a kind as a plain element: the span ASTRA UI
 * renders, with the public `surfaceGlyph` text for every kind but `paper`.
 */
function kindGlyph(kind: SurfaceKind): HTMLElement {
  const glyph = document.createElement('span');
  glyph.dataset.slot = 'kind-glyph';
  glyph.className = 'astra-kind-glyph';
  glyph.dataset.kind = kind;
  glyph.setAttribute('aria-hidden', 'true');
  if (kind === 'paper') glyph.append(paperGlyph());
  else glyph.textContent = surfaceGlyph(kind);
  return glyph;
}

/**
 * `AstraKindMark` as a plain element, for surfaces that React does not
 * render. Its scheme is the Lab's when it is made, so it is meant for views
 * that redraw as they are shown, such as the search palette.
 */
export function createKindMark(kind: SurfaceKind): HTMLElement {
  const mark = document.createElement('span');
  mark.className = KIND_MARK_CLASS;
  mark.dataset.lightconeColorScheme = scheme;
  mark.dataset.astraColorScheme = scheme;
  mark.append(kindGlyph(kind));
  return mark;
}

/**
 * A Lumino virtual DOM renderer that draws the kind mark into its host
 * element, for items such as command palette rows, whose icon slot takes a
 * renderer rather than React content.
 */
export function kindMarkRenderer(kind: SurfaceKind): VirtualElement.IRenderer {
  return {
    render: (host: HTMLElement) => {
      host.replaceChildren(createKindMark(kind));
    }
  };
}
