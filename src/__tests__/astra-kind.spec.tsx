import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { KindGlyph } from '@astra-spec/ui/primitives';
import type { SurfaceKind } from '@astra-spec/ui/model';
import type { IDisposable } from '@lumino/disposable';
import {
  AstraKindMark,
  bindLabColorScheme,
  createKindMark,
  kindMarkRenderer,
  labColorScheme
} from '../astra-kind';
import { FakeThemeManager } from '../versions/__tests__/theme-fixtures';

let actEnvironment: unknown;
beforeAll(() => {
  actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
});

/** Every test binds its own manager; the store is left light for the next. */
let bound: IDisposable | undefined;
afterEach(() => {
  bound?.dispose();
  bound = bindLabColorScheme(new FakeThemeManager());
  bound.dispose();
});

/** Bind the store to a manager showing `theme`, for the current test. */
function bind(theme: string): FakeThemeManager {
  const manager = new FakeThemeManager();
  manager.theme = theme;
  bound?.dispose();
  bound = bindLabColorScheme(manager);
  return manager;
}

/** Render `element` into a fresh root; `unmount` must run before the test ends. */
function mount(element: React.ReactElement): { node: HTMLElement; root: Root } {
  const node = document.createElement('div');
  const root = createRoot(node);
  act(() => root.render(element));
  return { node, root };
}

const schemeOf = (node: HTMLElement) =>
  node.querySelector<HTMLElement>('.lightcone-brand.astra-ui')?.dataset;

/** An element's markup with its attributes in name order, for comparison. */
function markup(element: Element): string {
  const attributes = Array.from(element.attributes)
    .map(({ name, value }) => `${name}="${value}"`)
    .sort()
    .join(' ');
  const children = Array.from(element.childNodes)
    .map(node => (node instanceof Element ? markup(node) : node.textContent))
    .join('');
  return `<${element.localName} ${attributes}>${children}</${element.localName}>`;
}

test('a mark follows the Lab theme through the theme manager', async () => {
  const manager = bind('JupyterLab Light');
  const { node, root } = mount(<AstraKindMark kind="input" />);
  try {
    expect(schemeOf(node)?.lightconeColorScheme).toBe('light');
    expect(node.querySelector('.astra-kind-glyph')?.textContent).toBe('▤');
    await act(() => manager.setTheme('JupyterLab Dark'));
    expect(schemeOf(node)?.lightconeColorScheme).toBe('dark');
    expect(schemeOf(node)?.astraColorScheme).toBe('dark');
  } finally {
    act(() => root.unmount());
  }
});

test('binding again replaces the earlier binding, and disposing stops following', async () => {
  const first = bind('JupyterLab Light');
  const second = new FakeThemeManager();
  second.theme = 'JupyterLab Dark';
  const binding = bindLabColorScheme(second);
  expect(labColorScheme()).toBe('dark');
  // The replaced manager no longer speaks for the Lab.
  await first.setTheme('JupyterLab Dark');
  await first.setTheme('JupyterLab Light');
  expect(labColorScheme()).toBe('dark');
  binding.dispose();
  expect(binding.isDisposed).toBe(true);
  await second.setTheme('JupyterLab Light');
  expect(labColorScheme()).toBe('dark');
});

test('plain marks take the scheme of the moment, even while React is committing', () => {
  bind('JupyterLab Dark');
  const drawn: HTMLElement[] = [];
  function Probe(): null {
    useLayoutEffect(() => {
      drawn.push(createKindMark('paper'), createKindMark('prior_insight'));
    }, []);
    return null;
  }
  const { root } = mount(<Probe />);
  act(() => root.unmount());
  const [paper, insight] = drawn;
  expect(paper.dataset.lightconeColorScheme).toBe('dark');
  expect(paper.dataset.astraColorScheme).toBe('dark');
  expect(
    paper.querySelector('.astra-kind-glyph[data-kind="paper"] > svg')
  ).not.toBeNull();
  expect(
    insight.querySelector('.astra-kind-glyph[data-kind="prior_insight"]')
      ?.textContent
  ).toBeTruthy();
  // Each call makes its own element.
  expect(createKindMark('paper').firstElementChild).not.toBe(
    paper.firstElementChild
  );
});

test.each<SurfaceKind>(['paper', 'decision', 'output'])(
  'a plain %s mark is the glyph ASTRA UI renders',
  kind => {
    const { node, root } = mount(<KindGlyph kind={kind} />);
    try {
      const rendered = node.firstElementChild;
      const plain = createKindMark(kind).firstElementChild;
      if (!rendered || !plain) throw new Error('No glyph was drawn.');
      expect(markup(plain)).toBe(markup(rendered));
    } finally {
      act(() => root.unmount());
    }
  }
);

test('a palette renderer replaces its host’s content with the mark', () => {
  const host = document.createElement('div');
  host.textContent = 'stale';
  kindMarkRenderer('decision').render(host);
  expect(host.children).toHaveLength(1);
  expect(
    host
      .querySelector('.lightcone-brand.astra-ui > .astra-kind-glyph')
      ?.getAttribute('data-kind')
  ).toBe('decision');
});
