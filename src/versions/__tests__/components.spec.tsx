import { TextDecoder } from 'node:util';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { ServerConnection } from '@jupyterlab/services';
import { ProvenanceTabs } from '../provenance-tabs';
import { BLINK_INTERVAL, VersionCompare } from '../version-compare';
import type { IVersionTarget } from '../version-content';
import { VersionStepper } from '../version-stepper';
import type { IOutputVersion } from '../versions-api';
import { METRIC_LEAF_LIMIT, type IRunView } from '../version-model';

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
  // What a history covers is stated wherever versions are shown.
  expect(
    container.querySelector('[role="note"]')?.getAttribute('title')
  ).toContain('git-annex keeps their content');
});

test('provenance tabs show the run and switch panels, loading sessions on demand', () => {
  const run: IRunView = {
    source: 'version',
    commit: 'c'.repeat(40),
    short: 'ccccccc',
    time: '2026-09-20T10:00:00Z',
    recipe: 'uv run plot.py',
    gitRevision: 'def456',
    engineVersion: '0.6',
    environmentVersion: 'sha256:env',
    sandbox: 'backend: landlock',
    inputVersions: { catalog: 'sha256:input' },
    decisions: { method: 'robust' }
  };
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
          },
          {
            id: 'cosmology_fit',
            version: 'sha256:upstream',
            record: {
              kind: 'output',
              id: 'cosmology_fit',
              canonicalPath: 'outputs.cosmology_fit',
              label: 'Cosmology fit',
              type: 'table'
            } as unknown as NonNullable<
              React.ComponentProps<
                typeof ProvenanceTabs
              >['inputs'][number]['record']
            >
          },
          { id: 'dropped', version: 'sha256:dropped' }
        ]}
      />
    );
  });
  const panel = () => container.querySelector('[role="tabpanel"]')!;
  expect(panel().textContent).toContain('uv run plot.py');
  expect(panel().textContent).toContain('stale');
  expect(panel().textContent).toContain('recipe changed');
  expect(panel().textContent).toContain('backend: landlock');
  act(() => button('Code').click());
  expect(panel().textContent).toContain('plot.py');
  act(() => button('Open current file').click());
  expect(onOpenCode).toHaveBeenCalledWith('plot.py');
  act(() => button('Inputs').click());
  expect(panel().textContent).toContain('Catalog');
  // Each recorded input carries its record's inventory mark: an upstream
  // output keeps the output mark, and an id no longer declared has none.
  expect(
    Array.from(
      panel().querySelectorAll('.jp-jupyterlab-lightcone-Provenance-inputs li'),
      row =>
        row
          .querySelector(
            ':scope > .lightcone-brand.astra-ui > .astra-kind-glyph'
          )
          ?.getAttribute('data-kind') ?? null
    )
  ).toEqual(['input', 'output', null]);
  expect(panel().textContent).toContain('Cosmology fit');
  act(() => button('Catalog').click());
  expect(openInput).toHaveBeenCalled();
  act(() => button('Environment').click());
  expect(panel().textContent).toContain('sha256:env');
  expect(panel().textContent).toContain('robust');
  // The decisions the run resolved carry the inventory's decision mark.
  expect(
    Array.from(
      panel().querySelectorAll(
        '.jp-jupyterlab-lightcone-Provenance-list li > .lightcone-brand.astra-ui > .astra-kind-glyph'
      ),
      glyph => glyph.getAttribute('data-kind')
    )
  ).toEqual(['decision']);
  // The tabs are the run's own records; no session is matched to a run.
  expect(
    Array.from(
      container.querySelectorAll('[role="tab"]'),
      tab => tab.textContent
    )
  ).toEqual(['Run', 'Code', 'Inputs', 'Environment']);
});

test('the Code tab shows the script as run and its changes since', () => {
  const run: IRunView = {
    source: 'version',
    commit: 'c'.repeat(40),
    gitRevision: 'd'.repeat(40),
    inputVersions: {},
    decisions: {}
  };
  const onShowCode = jest.fn();
  const onShowEnvironment = jest.fn();
  const render = (
    extra: Partial<React.ComponentProps<typeof ProvenanceTabs>>
  ) =>
    act(() => {
      root.render(
        <ProvenanceTabs
          run={run}
          code={{ relativePath: 'src/plot.py', source: 'recorded run' }}
          inputs={[]}
          onShowCode={onShowCode}
          onShowEnvironment={onShowEnvironment}
          {...extra}
        />
      );
    });
  render({});
  const panel = () => container.querySelector('[role="tabpanel"]')!;
  act(() => button('Code').click());
  expect(onShowCode).toHaveBeenCalledTimes(1);
  expect(panel().textContent).toContain('Reading the script at ddddddd');
  render({
    recordedCode: {
      loading: false,
      source: {
        file: 'src/plot.py',
        commit: 'd'.repeat(40),
        exists: true,
        text: 'a = 1\nb = 2\n',
        binary: false,
        annexed: false,
        truncated: false
      },
      current: 'a = 1\nb = 3\n'
    }
  });
  expect(panel().querySelector('pre code')?.textContent).toBe('a = 1\nb = 2\n');
  act(() => button('Changes since').click());
  const diff = panel().querySelector(
    '.jp-jupyterlab-lightcone-Provenance-diff'
  )!;
  expect(diff.querySelector('.jp-mod-removed')?.textContent).toBe('- b = 2\n');
  expect(diff.querySelector('.jp-mod-added')?.textContent).toBe('+ b = 3\n');
  render({
    recordedCode: {
      loading: false,
      source: {
        file: 'src/plot.py',
        commit: 'd'.repeat(40),
        exists: false,
        text: null,
        binary: false,
        annexed: false,
        truncated: false
      },
      current: null
    }
  });
  expect(panel().textContent).toContain('did not exist at ddddddd');
  act(() => button('Environment').click());
  expect(onShowEnvironment).toHaveBeenCalledTimes(1);
  render({
    packages: {
      loading: false,
      locked: {
        commit: 'd'.repeat(40),
        packages: [
          { name: 'numpy', version: '2.1.0' },
          { name: 'scipy', version: '1.0' }
        ],
        current: [
          { name: 'numpy', version: '2.2.0' },
          { name: 'astropy', version: '6.0' }
        ]
      }
    }
  });
  expect(panel().textContent).toContain('2 packages locked');
  expect(panel().textContent).toContain('3 changes since');
  expect(panel().textContent).toContain('numpy 2.1.0 → 2.2.0');
  expect(panel().textContent).toContain('astropy added (6.0)');
  expect(panel().textContent).toContain('scipy removed (was 1.0)');
  act(() => button('Show every locked package').click());
  expect(panel().textContent).toContain('scipy 1.0');
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

describe('version comparison', () => {
  const target: IVersionTarget = {
    settings: ServerConnection.makeSettings({
      baseUrl: 'http://localhost:8888/lab/'
    }),
    entrypoint: 'project/astra.yaml',
    universe: 'baseline',
    outputId: 'fit'
  };
  const [newer, older] = versions;
  const output = (type: string, format: string) =>
    ({
      kind: 'output',
      id: 'fit',
      canonicalPath: 'outputs.fit',
      label: 'Fit',
      type,
      format
    }) as unknown as ResolvedOutput;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'TextDecoder', {
      value: TextDecoder,
      configurable: true
    });
  });

  /** Serve each commit's bytes from the versions content route. */
  function serve(bodies: Record<string, string>): void {
    jest
      .spyOn(ServerConnection, 'makeRequest')
      .mockImplementation(async url => {
        const commit = new URL(url).searchParams.get('commit') ?? '';
        const body = bodies[commit];
        return body === undefined
          ? new Response('{"reason": "absent"}', { status: 404 })
          : new Response(body);
      });
  }

  async function compare(type: string, format: string): Promise<void> {
    await act(async () => {
      root.render(
        <VersionCompare
          target={target}
          output={output(type, format)}
          newer={newer}
          older={older}
        />
      );
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!/Comparing (values|tables)…/.test(container.textContent ?? ''))
        return;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('JSON metrics compare value by value', async () => {
    serve({
      [older.commit]: '{"value": 0.3, "unit": "mag", "gone": 1}',
      [newer.commit]: '{"value": 0.31, "extra": 2, "gone": 1}'
    });
    await compare('metric', 'json');
    const rows = Array.from(container.querySelectorAll('tbody tr')).map(row =>
      Array.from(row.children).map(cell => cell.textContent)
    );
    expect(rows).toEqual([
      ['value', '0.3', '0.31', '+0.01'],
      ['extra', '—', '2', 'added'],
      ['gone', '1', '1', 'unchanged']
    ]);
    expect(container.querySelector('h4')?.textContent).toBe(
      'Comparing ccccccc with the previous version bbbbbbb'
    );
  });

  test('a large JSON metric compares a bounded number of values', async () => {
    const values = JSON.stringify(
      Array.from({ length: METRIC_LEAF_LIMIT + 100 }, (_, index) => index)
    );
    serve({ [older.commit]: values, [newer.commit]: values });
    await compare('metric', 'json');
    expect(container.textContent).toContain(
      `Showing the first ${METRIC_LEAF_LIMIT} values of each version.`
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(
      METRIC_LEAF_LIMIT
    );
  });

  test('JSON and delimited tables compare by shape', async () => {
    serve({
      [older.commit]: '[{"a": 1, "b": 2}]',
      [newer.commit]: '[{"b": 1, "a": 2}, {"b": 3, "a": 4}]'
    });
    await compare('table', 'json');
    expect(container.textContent).toContain('same columns in another order');
    expect(container.textContent).toContain('+1');
    jest.restoreAllMocks();
    serve({
      [older.commit]: 'a,b\n1,2\n',
      [newer.commit]: 'a,c\n1,2\n3,4\n'
    });
    await compare('table', 'csv');
    expect(container.textContent).toContain('added c');
    expect(container.textContent).toContain('removed b');
  });

  test('images offer a swipe only when both versions are present', async () => {
    await act(async () => {
      root.render(
        <VersionCompare
          target={target}
          output={output('figure', 'png')}
          newer={newer}
          older={{ ...older, present: false }}
        />
      );
    });
    expect(button('Swipe').disabled).toBe(true);
    expect(container.textContent).toContain('not in this repository');
    act(() => {
      root.render(
        <VersionCompare
          target={target}
          output={output('figure', 'png')}
          newer={newer}
          older={older}
        />
      );
    });
    act(() => button('Swipe').click());
    const slider = container.querySelector<HTMLInputElement>(
      'input[type="range"]'
    )!;
    expect(slider).not.toBeNull();
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(new URL(images[0].src).searchParams.get('commit')).toBe(
      older.commit
    );
  });

  test('images blink between the two versions, pausing on demand', async () => {
    jest.useFakeTimers();
    try {
      act(() => {
        root.render(
          <VersionCompare
            target={target}
            output={output('figure', 'png')}
            newer={newer}
            older={older}
          />
        );
      });
      act(() => button('Blink').click());
      const images = container.querySelectorAll('img');
      expect(images).toHaveLength(2);
      const top = images[1];
      expect(top.style.visibility).toBe('visible');
      expect(container.textContent).toContain('Shown');
      act(() => jest.advanceTimersByTime(BLINK_INTERVAL));
      expect(top.style.visibility).toBe('hidden');
      expect(container.textContent).toContain('Previous');
      act(() => button('Pause').click());
      act(() => jest.advanceTimersByTime(BLINK_INTERVAL * 3));
      expect(top.style.visibility).toBe('hidden');
      act(() => button('Show newer').click());
      expect(top.style.visibility).toBe('visible');
    } finally {
      jest.useRealTimers();
    }
  });

  test('formats without a comparison say so', async () => {
    await compare('data', 'npz');
    expect(container.textContent).toContain(
      'No comparison is available for .npz artifacts.'
    );
  });
});
