import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../../commands';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { cancelRun, getRun, listRuns, startRun, type IJob } from '../runs-api';
import { RunsCommandIDs } from '../runs-commands';
import { RunsWidget } from '../runs-widget';
import { job, refused, run, runsHost, until } from './runs-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const CLASS = 'jp-jupyterlab-lightcone-Runs';

/** A project without universes, with one figure and one table. */
const PROJECT_SPEC = `version: "0.0.14"
name: Runs project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
  - id: cosmology_fit
    type: table
    format: json
    inputs: [catalog]
`;

/** How many times the materialization status was read. */
let statusReads = 0;

function host(listing: { jobs?: IJob[]; runs?: ReturnType<typeof run>[] }) {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC)
  });
  jest
    .mocked(listRuns)
    .mockResolvedValue({ runs: listing.runs ?? [], jobs: listing.jobs ?? [] });
  const runs = runsHost();
  const commands = new CommandRegistry();
  const executed: [string, ReadonlyPartialJSONObject][] = [];
  for (const command of [
    CommandIDs.openElement,
    CommandIDs.openInventory,
    RunsCommandIDs.openRuns
  ]) {
    commands.addCommand(command, {
      execute: args => {
        executed.push([command, args]);
      }
    });
  }
  const widget = new RunsWidget(ENTRYPOINT, runs.service, contents, commands);
  Widget.attach(widget, document.body);
  const text = () => widget.node.textContent ?? '';
  const button = (label: string): HTMLButtonElement => {
    const found = Array.from(
      widget.node.querySelectorAll<HTMLButtonElement>('button')
    ).find(item => item.textContent === label);
    if (!found) {
      throw new Error(`No button reads ${label}.`);
    }
    return found;
  };
  const alerts = () =>
    Array.from(widget.node.querySelectorAll('[role=alert]')).map(
      node => node.textContent
    );
  return {
    service: runs.service,
    emit: runs.emit,
    commands,
    executed,
    widget,
    text,
    button,
    alerts,
    dispose: () => {
      Widget.detach(widget);
      widget.dispose();
      runs.dispose();
      contents.dispose();
    }
  };
}

/** Type into a React-controlled input. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  statusReads = 0;
  jest.mocked(requestAPI).mockReset();
  jest.mocked(requestAPI).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      statusReads += 1;
      return {
        outputs: {
          'default/hubble_diagram': { state: 'stale', detail: '' },
          'default/cosmology_fit': { state: 'behind', detail: 'recipe' }
        }
      };
    }
    throw new Error(`Unexpected request to ${endpoint}`);
  });
  jest.mocked(listRuns).mockReset();
  jest.mocked(startRun).mockReset();
  jest.mocked(cancelRun).mockReset();
  jest.mocked(getRun).mockReset();
  // Running jobs are polled; these reads never answer.
  jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  jest.useRealTimers();
});

it('shows live jobs, refusals and the history, and routes their actions', async () => {
  const h = host({
    jobs: [
      job({
        id: 'job-2',
        targets: ['hubble_diagram'],
        lines: ['step 1'],
        started: '2026-09-23T11:59:00.000Z'
      }),
      job({
        state: 'failed',
        exit: 1,
        finished: '2026-09-23T11:58:40.000Z',
        lines: ['Error: dirty tree', '  M src/plot.py']
      })
    ],
    runs: [run({ universe: 'default' })]
  });
  try {
    await until(() => h.widget.title.label === 'Runs · Runs project');
    await until(() => h.text().includes('python src/plot.py'));
    // Without universes, outputs are named without one, after the
    // inventory's output mark.
    const runOutput = h.widget.node.querySelector(`.${CLASS}-runOutput`);
    expect(runOutput?.textContent).toBe('◆hubble_diagram');
    expect(
      runOutput
        ?.querySelector('.lightcone-brand.astra-ui > .astra-kind-glyph')
        ?.getAttribute('data-kind')
    ).toBe('output');
    expect(h.text()).toContain('Materialize hubble_diagram');
    expect(h.text()).toContain('step 1');
    expect(h.text()).toContain('The engine refused to run');
    expect(h.text()).toContain('Error: dirty tree');
    // One job at a time: the form waits for the running one.
    expect(h.text()).toContain('A materialization is running');
    expect(h.button('Materialize').disabled).toBe(true);

    jest.mocked(cancelRun).mockResolvedValue(undefined);
    h.button('Stop').click();
    await until(() => jest.mocked(cancelRun).mock.calls.length > 0);
    expect(cancelRun).toHaveBeenCalledWith(
      expect.anything(),
      ENTRYPOINT,
      'job-2'
    );

    h.widget.node.querySelector<HTMLButtonElement>(`.${CLASS}-run`)!.click();
    h.button('Open inventory →').click();
    await until(() => h.executed.length === 2);
    // Without universes, a record tab is not pinned to one; a run opens the
    // version it made.
    expect(h.executed).toEqual([
      [
        CommandIDs.openElement,
        {
          entrypoint: ENTRYPOINT,
          target: 'outputs.hubble_diagram',
          versionCommit: 'a889877deadbeef'
        }
      ],
      [CommandIDs.openInventory, { path: ENTRYPOINT }]
    ]);
  } finally {
    h.dispose();
  }
});

it('marks the outputs a finished job reports with their kind', async () => {
  const h = host({
    jobs: [
      job({
        state: 'failed',
        exit: 1,
        finished: '2026-09-23T11:58:40.000Z',
        report: {
          ok: false,
          made: ['default/hubble_diagram'],
          failed: ['default/cosmology_fit'],
          behind: { 'default/hubble_diagram': 'recipe changed' }
        }
      })
    ]
  });
  try {
    await until(() => h.text().includes('is behind: recipe changed'));
    const chips = Array.from(
      h.widget.node.querySelectorAll<HTMLButtonElement>(`.${CLASS}-chip`)
    );
    expect(chips.map(chip => [chip.dataset.tone, chip.textContent])).toEqual([
      ['made', '◆hubble_diagram'],
      ['failed', '◆cosmology_fit']
    ]);
    const reason = h.widget.node.querySelector(`.${CLASS}-reasons button`);
    const marked = [...chips, reason].map(node =>
      node
        ?.querySelector('.lightcone-brand.astra-ui > .astra-kind-glyph')
        ?.getAttribute('data-kind')
    );
    expect(marked).toEqual(['output', 'output', 'output']);
  } finally {
    h.dispose();
  }
});

it('starts stale and behind outputs, and says why a start failed', async () => {
  const h = host({});
  try {
    await until(() => h.text().includes('Refresh behind (1)'));
    jest
      .mocked(startRun)
      .mockResolvedValue(
        job({ targets: ['default/cosmology_fit'], refresh: true })
      );
    h.button('Refresh behind (1)').click();
    await until(() => h.text().includes('A materialization is running'));
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['default/cosmology_fit'],
      refresh: true
    });
    expect(h.button('Rematerialize stale (1)').disabled).toBe(true);

    // It ends; a job started elsewhere now holds the project.
    jest
      .mocked(getRun)
      .mockResolvedValue(job({ state: 'succeeded', exit: 0, refresh: true }));
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [] });
    h.emit({ id: 'job-1', project: 'project', state: 'succeeded', line: null });
    await until(() => !h.button('Rematerialize stale (1)').disabled);
    const elsewhere = job({ id: 'job-9', project: 'project' });
    jest.mocked(startRun).mockRejectedValue(refused(409));
    jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [elsewhere] });
    h.button('Rematerialize stale (1)').click();
    await until(() => h.alerts().length > 0);
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['default/hubble_diagram'],
      refresh: false
    });
    expect(h.alerts()).toEqual([
      'A materialization is already running for this project. Wait for it to finish or stop it first.'
    ]);
    // The listing is re-read, so the unknown job blocks further starts.
    await until(() => h.text().includes('A materialization is running'));
  } finally {
    h.dispose();
  }
});

it('refuses targets the engine would misread', async () => {
  const h = host({});
  try {
    await until(() => h.text().includes('Refresh behind (1)'));
    const input = h.widget.node.querySelector<HTMLInputElement>('input')!;
    type(input, 'hubble_diagram --check');
    h.widget.node.querySelector('form')!.requestSubmit();
    await until(() => h.alerts().length > 0);
    expect(h.alerts()).toEqual(['Not an output name: --check']);
    expect(startRun).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('re-reads the status after each end, even with a full job list', async () => {
  const ended = (i: number) =>
    job({
      id: `j${i}`,
      project: 'project',
      state: 'succeeded',
      exit: 0,
      finished: `2026-09-23T10:${String(i).padStart(2, '0')}:30.000Z`,
      started: `2026-09-23T10:${String(i).padStart(2, '0')}:00.000Z`
    });
  const full = Array.from({ length: 20 }, (_, i) => ended(i)).reverse();
  const h = host({ jobs: full });
  try {
    await until(() => h.text().includes('Refresh behind (1)'));
    await until(() => statusReads > 0);
    const reads = statusReads;
    // A job started and ended elsewhere replaces the oldest in the listing.
    jest
      .mocked(listRuns)
      .mockResolvedValue({ runs: [], jobs: [ended(20), ...full.slice(0, 19)] });
    await h.service.refresh(ENTRYPOINT);
    await until(() => statusReads > reads);
    expect(statusReads).toBe(reads + 1);
  } finally {
    h.dispose();
  }
});

it('keeps relative times current while nothing runs', async () => {
  // Only the clock is fake: rendering and requests keep real timers.
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout'
    ],
    now: new Date(2026, 8, 23, 12)
  });
  const h = host({
    runs: [run({ time: new Date(2026, 8, 23, 11, 59, 50).toISOString() })]
  });
  try {
    await until(() => h.text().includes('just now'));
    jest.advanceTimersByTime(3 * 60_000);
    await until(() => h.text().includes('3 min ago'));
    expect(h.text()).not.toContain('just now');
  } finally {
    h.dispose();
  }
});

it('groups the history by invocation and says where runs execute', async () => {
  const h = host({
    runs: [
      run({
        commit: 'c1',
        short: 'c1',
        output: 'hubble_diagram',
        universe: 'default',
        invocation: 'abcdef1234'
      }),
      run({
        commit: 'c2',
        short: 'c2',
        output: 'cosmology_fit',
        universe: 'default',
        invocation: 'abcdef1234'
      })
    ]
  });
  jest.mocked(listRuns).mockResolvedValue({
    runs: [
      run({ commit: 'c1', output: 'hubble_diagram', invocation: 'abcdef1234' }),
      run({ commit: 'c2', output: 'cosmology_fit', invocation: 'abcdef1234' })
    ],
    jobs: [],
    venue: { slurm: true, nodes: 3 }
  });
  try {
    await h.service.refresh(ENTRYPOINT);
    await until(() => h.text().includes('One lc materialize'));
    expect(h.text()).toContain('One lc materialize · 2 outputs · from abcdef1');
    expect(
      h.widget.node.querySelectorAll(`.${CLASS}-invocation li`)
    ).toHaveLength(2);
    expect(h.text()).toContain(
      'Runs execute across this SLURM allocation: 3 nodes, one worker each.'
    );
  } finally {
    h.dispose();
  }
});
