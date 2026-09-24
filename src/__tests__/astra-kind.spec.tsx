import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstraKindMark, createKindMark, kindMarkRenderer } from '../astra-kind';

let actEnvironment: unknown;
beforeAll(() => {
  actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
});
afterEach(() => {
  delete document.body.dataset.jpThemeLight;
  jest.restoreAllMocks();
});

/** Render `element` into a fresh root; `unmount` must run before the test ends. */
function mount(element: React.ReactElement): { node: HTMLElement; root: Root } {
  const node = document.createElement('div');
  const root = createRoot(node);
  act(() => root.render(element));
  return { node, root };
}

const schemeOf = (node: HTMLElement) =>
  node.querySelector<HTMLElement>('.lightcone-brand.astra-ui')?.dataset;

test('a mark follows the Lab theme between light and dark', async () => {
  document.body.dataset.jpThemeLight = 'true';
  const { node, root } = mount(<AstraKindMark kind="input" />);
  try {
    expect(schemeOf(node)?.lightconeColorScheme).toBe('light');
    expect(node.querySelector('.astra-kind-glyph')?.textContent).toBe('▤');
    // The theme plugin restamps the attribute; the observer reports it.
    await act(async () => {
      document.body.dataset.jpThemeLight = 'false';
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(schemeOf(node)?.lightconeColorScheme).toBe('dark');
    expect(schemeOf(node)?.astraColorScheme).toBe('dark');
  } finally {
    act(() => root.unmount());
  }
});

test('one observer serves every mark and stops with the last one', () => {
  const observe = jest.spyOn(MutationObserver.prototype, 'observe');
  const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');
  const first = mount(<AstraKindMark kind="output" />);
  const second = mount(<AstraKindMark kind="decision" />);
  expect(observe).toHaveBeenCalledTimes(1);
  act(() => first.root.unmount());
  expect(disconnect).not.toHaveBeenCalled();
  act(() => second.root.unmount());
  expect(disconnect).toHaveBeenCalledTimes(1);
  // A later mark starts a new observer.
  const third = mount(<AstraKindMark kind="finding" />);
  expect(observe).toHaveBeenCalledTimes(2);
  act(() => third.root.unmount());
});

test('plain marks draw ASTRA UI’s glyph even while React is committing', () => {
  document.body.dataset.jpThemeLight = 'false';
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
  expect(
    paper.querySelector('.astra-kind-glyph[data-kind="paper"] > svg')
  ).not.toBeNull();
  expect(
    insight.querySelector('.astra-kind-glyph[data-kind="prior_insight"]')
      ?.textContent
  ).toBeTruthy();
  // Each call returns its own copy of the kept glyph.
  expect(createKindMark('paper').firstElementChild).not.toBe(
    paper.firstElementChild
  );
});

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
