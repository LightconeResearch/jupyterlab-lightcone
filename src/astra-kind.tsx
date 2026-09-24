import type { SurfaceKind } from '@astra-spec/ui/model';
import { KindGlyph } from '@astra-spec/ui/primitives';
import type { VirtualElement } from '@lumino/virtualdom';
import React, { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ColorScheme } from './theme-adapter';

/**
 * The classes of a kind mark's root: the Lightcone ASTRA theme's scope, which
 * supplies the kind colours, and the host class that keeps it inline.
 */
const KIND_MARK_CLASS =
  'lightcone-brand astra-ui jp-jupyterlab-lightcone-KindMark';

/**
 * The Lab's color scheme as `<body>` declares it. JupyterLab's theme plugin
 * stamps `data-jp-theme-light` with the theme manager's own `isLight` verdict
 * whenever a theme applies, so this agrees with `colorScheme` in
 * `theme-adapter.ts`. Views that hold the `IThemeManager` bind to it with
 * `LightconeThemeBinding`; kind marks read the attribute instead, since they
 * are drawn in many components that are not handed the manager.
 */
export function labColorScheme(): ColorScheme {
  return document.body.dataset.jpThemeLight === 'false' ? 'dark' : 'light';
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

/** One observer serves every mark on the page; it stops with the last subscriber. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      listeners.forEach(notify => notify());
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-jp-theme-light']
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** The Lab's current color scheme, re-rendering when the theme changes. */
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
 */
export function AstraKindMark({
  kind,
  className
}: IAstraKindMarkProps): React.ReactElement {
  const scheme = useLabColorScheme();
  return (
    <span
      className={`${KIND_MARK_CLASS}${className ? ` ${className}` : ''}`}
      data-lightcone-color-scheme={scheme}
      data-astra-color-scheme={scheme}
    >
      <KindGlyph kind={kind} />
    </span>
  );
}

/**
 * Every kind ASTRA UI marks, as a record so that the compiler reports a kind
 * added upstream until it is listed here.
 */
const SURFACE_KINDS: Readonly<Record<SurfaceKind, null>> = {
  analysis: null,
  input: null,
  decision: null,
  output: null,
  finding: null,
  prior_insight: null,
  paper: null
};

function isSurfaceKind(value: string): value is SurfaceKind {
  return Object.prototype.hasOwnProperty.call(SURFACE_KINDS, value);
}

const glyphTemplates = new Map<SurfaceKind, Element>();

/**
 * KindGlyph's own markup for a kind, rendered once by ASTRA UI and kept, so
 * the DOM-built marks below never restate its symbols or its paper drawing.
 *
 * It renders through the shared React DOM with `flushSync`, which cannot draw
 * while React itself renders or commits. Every known kind is therefore drawn
 * as this module loads (below), and only a kind unknown then is drawn on
 * first use, where that limit applies. (`react-dom/server` is not an option:
 * a bundled copy of it does not match the React build JupyterLab shares.)
 */
function glyphTemplate(kind: SurfaceKind): Element {
  let template = glyphTemplates.get(kind);
  if (!template) {
    const container = document.createElement('span');
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KindGlyph kind={kind} />);
    });
    const glyph = container.firstElementChild?.cloneNode(true);
    root.unmount();
    if (!(glyph instanceof Element)) {
      throw new Error(`ASTRA UI drew no glyph for the ${kind} kind.`);
    }
    template = glyph;
    glyphTemplates.set(kind, template);
  }
  return template;
}

// Loading the module happens outside any React render, so every kind draws.
Object.keys(SURFACE_KINDS).filter(isSurfaceKind).forEach(glyphTemplate);

/**
 * `AstraKindMark` as a plain element, for surfaces that React does not
 * render. Its scheme is the Lab's when it is made, so it is meant for views
 * that redraw as they are shown, such as the search palette.
 */
export function createKindMark(kind: SurfaceKind): HTMLElement {
  const scheme = labColorScheme();
  const mark = document.createElement('span');
  mark.className = KIND_MARK_CLASS;
  mark.dataset.lightconeColorScheme = scheme;
  mark.dataset.astraColorScheme = scheme;
  mark.append(glyphTemplate(kind).cloneNode(true));
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
