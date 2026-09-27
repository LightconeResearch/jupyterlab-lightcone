import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDisposable } from '@lumino/disposable';
import { h, VirtualDOM } from '@lumino/virtualdom';
import {
  AstraKindMark,
  bindLabColorScheme,
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

test('a virtual DOM mark reuses its root, follows themes and unmounts on removal', async () => {
  const manager = bind('JupyterLab Light');
  const host = document.createElement('div');
  const draw = (kind: 'paper' | 'decision') =>
    act(() =>
      VirtualDOM.render(h.div({ key: 'kind' }, kindMarkRenderer(kind)), host)
    );
  try {
    draw('paper');
    const container = host.firstElementChild;
    expect(host.querySelector('.astra-kind-glyph svg')).not.toBeNull();
    // A new renderer object may be handed the same host at every palette update.
    draw('paper');
    draw('decision');
    expect(host.firstElementChild).toBe(container);
    expect(host.querySelector('.astra-kind-glyph')?.textContent).toBe('◇');
    await act(() => manager.setTheme('JupyterLab Dark'));
    expect(schemeOf(host)?.astraColorScheme).toBe('dark');
    act(() => VirtualDOM.render(null, host));
    expect(container?.childElementCount).toBe(0);
    await act(() => manager.setTheme('JupyterLab Light'));
    expect(container?.childElementCount).toBe(0);
    // The same containing widget can render another mark after being cleared.
    draw('paper');
    expect(schemeOf(host)?.astraColorScheme).toBe('light');
  } finally {
    act(() => VirtualDOM.render(null, host));
  }
});
