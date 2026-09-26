import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VersionStepper } from '../version-stepper';
import type { IOutputVersion } from '../versions-api';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function version(commit: string, time: string): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time,
    subject: '',
    size: 208410,
    present: true,
    annex: null,
    manifest: null
  };
}

const versions = [
  version('c'.repeat(40), '2026-09-20T10:00:00Z'),
  version('b'.repeat(40), '2026-09-18T10:00:00Z'),
  version('a'.repeat(40), '2026-09-15T10:00:00Z')
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    item =>
      item.getAttribute('aria-label') === name || item.textContent === name
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

test('the stepper names the shown version and steps towards older and newer ones', () => {
  const onSelect = jest.fn();
  const render = (selected: string | undefined) =>
    act(() => {
      root.render(
        <VersionStepper
          versions={versions}
          selected={selected}
          onSelect={onSelect}

          loading={false}
          error={undefined}
        />
      );
    });
  render(undefined);
  expect(container.textContent).toContain('v3 of 3');
  expect(container.textContent).toContain('ccccccc');
  expect(container.textContent).toContain('208 kB');
  expect(button('Newer version').disabled).toBe(true);
  act(() => button('Older version').click());
  expect(onSelect).toHaveBeenLastCalledWith('b'.repeat(40));
  render('b'.repeat(40));
  expect(container.textContent).toContain('v2 of 3');
  // Stepping back to the newest version clears the selection.
  act(() => button('Newer version').click());
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
  render('a'.repeat(40));
  expect(button('Older version').disabled).toBe(true);
  expect(container.querySelector('[aria-pressed]')).toBeNull();
});

test('the stepper reports loading, failure and an empty history', () => {
  const props = {
    versions: [],
    selected: undefined,
    onSelect: jest.fn(),
    canCompare: false,
    compareOpen: false,
    onCompareChange: jest.fn()
  };
  act(() => {
    root.render(<VersionStepper {...props} loading error={undefined} />);
  });
  expect(container.textContent).toContain('Loading versions');
  act(() => {
    root.render(<VersionStepper {...props} loading={false} error="boom" />);
  });
  expect(container.textContent).toContain('Version history unavailable: boom');
  act(() => {
    root.render(
      <VersionStepper {...props} loading={false} error={undefined} />
    );
  });
  expect(container.textContent).toContain('No committed versions');
  // What a history covers is stated wherever versions are shown.
  expect(
    container.querySelector('[role="note"]')?.getAttribute('title')
  ).toContain('git-annex keeps their content');
});
