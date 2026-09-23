import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProvenanceTabs } from '../provenance-tabs';
import { VersionStepper } from '../version-stepper';
import type { IOutputVersion } from '../versions-api';
import type { IRunView } from '../version-model';

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
    key: null,
    size: 208410,
    present: true,
    run: null,
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
  const onCompareChange = jest.fn();
  const render = (selected: string | undefined) =>
    act(() => {
      root.render(
        <VersionStepper
          versions={versions}
          selected={selected}
          onSelect={onSelect}
          canCompare
          compareOpen={false}
          onCompareChange={onCompareChange}
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
  act(() => button('Compare with previous').click());
  expect(onCompareChange).toHaveBeenCalledWith(true);
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
});

test('provenance tabs show the run and switch panels, loading sessions on demand', () => {
  const run: IRunView = {
    source: 'version',
    commit: 'c'.repeat(40),
    short: 'ccccccc',
    time: '2026-09-20T10:00:00Z',
    command: 'uv run plot.py',
    exit: 1,
    gitRevision: 'def456',
    engineVersion: '0.6',
    environmentVersion: 'sha256:env',
    sandbox: 'backend: landlock',
    inputVersions: { catalog: 'sha256:input' },
    decisions: { method: 'robust' },
    inputs: ['data/catalog.csv'],
    outputs: []
  };
  const onShowConversation = jest.fn();
  const onOpenCode = jest.fn();
  const openInput = jest.fn();
  act(() => {
    root.render(
      <ProvenanceTabs
        status={{ state: 'stale', detail: 'recipe changed' }}
        run={run}
        code={{ relativePath: 'plot.py', source: 'recorded run' }}
        onOpenCode={onOpenCode}
        inputs={[
          {
            id: 'catalog',
            version: 'sha256:input',
            record: {
              kind: 'input',
              id: 'catalog',
              canonicalPath: 'inputs.catalog',
              label: 'Catalog',
              type: 'data'
            } as unknown as NonNullable<
              React.ComponentProps<
                typeof ProvenanceTabs
              >['inputs'][number]['record']
            >,
            onOpen: openInput
          }
        ]}
        sessions={{
          loading: false,
          total: 2,
          items: [
            {
              path: 'chats/hubble.chat',
              title: 'Hubble diagram',
              modified: '2026-09-20T10:05:00Z',
              messages: 4,
              lastAgent: 'Lightcone Agent',
              activity: 'idle'
            }
          ]
        }}
        onShowConversation={onShowConversation}
      />
    );
  });
  const panel = () => container.querySelector('[role="tabpanel"]')!;
  expect(panel().textContent).toContain('uv run plot.py');
  expect(panel().textContent).toContain('stale');
  expect(panel().textContent).toContain('recipe changed');
  expect(panel().textContent).toContain('backend: landlock');
  expect(panel().querySelector('[data-failed]')?.textContent).toBe('1');
  act(() => button('Code').click());
  expect(panel().textContent).toContain('plot.py');
  act(() => button('Open current file').click());
  expect(onOpenCode).toHaveBeenCalledWith('plot.py');
  act(() => button('Inputs').click());
  expect(panel().textContent).toContain('Catalog');
  expect(panel().textContent).toContain('data/catalog.csv');
  act(() => button('Catalog').click());
  expect(openInput).toHaveBeenCalled();
  act(() => button('Environment').click());
  expect(panel().textContent).toContain('sha256:env');
  expect(panel().textContent).toContain('robust');
  expect(onShowConversation).not.toHaveBeenCalled();
  act(() => button('Conversation').click());
  expect(onShowConversation).toHaveBeenCalledTimes(1);
  expect(panel().textContent).toContain('Hubble diagram');
  expect(panel().textContent).toContain('Heuristic');
  act(() => button('Run').click());
  act(() => button('Conversation').click());
  expect(onShowConversation).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  ).toBe('Conversation');
});

test('provenance tabs explain a missing or unreadable record', () => {
  act(() => {
    root.render(<ProvenanceTabs run={null} inputs={[]} />);
  });
  expect(container.textContent).toContain('No run has been recorded');
  act(() => {
    root.render(<ProvenanceTabs run={undefined} error="nope" inputs={[]} />);
  });
  expect(container.textContent).toContain('nope');
});
