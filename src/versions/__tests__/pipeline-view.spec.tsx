import type { ILabShell } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { TabProjectLabels } from '../../tab-labels';
import { TAB_PROJECT_DATASET_KEY } from '../../workbench-ids';
import { Widget } from '@lumino/widgets';
import { FakeThemeManager } from './theme-fixtures';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { until } from '../../__tests__/async-fixtures';
import { CommandIDs } from '../../commands';
import { PipelineWidget } from '../pipeline-view';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const SPEC = `version: "0.0.14"
name: Pipeline project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
`;

beforeEach(() => {
  jest.mocked(requestAPI).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return {
        outputs: { 'default/hubble_diagram': { state: 'current', detail: '' } }
      };
    }
    return { papers: {} };
  });
});

test('pipeline nodes and counts carry the inventory’s kind marks', async () => {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(SPEC) });
  const widget = new PipelineWidget(
    ENTRYPOINT,
    contents,
    new FakeThemeManager(),
    new CommandRegistry()
  );
  Widget.attach(widget, document.body);
  try {
    const node = widget.node;
    await until(
      () =>
        node.querySelectorAll('.jp-jupyterlab-lightcone-Pipeline-node')
          .length === 2
    );
    const kindOf = (scope: Element) =>
      Array.from(
        scope.querySelectorAll('.lightcone-brand.astra-ui > .astra-kind-glyph'),
        glyph => glyph.getAttribute('data-kind')
      );
    // One mark per node, drawn by ASTRA UI inside the SVG.
    const nodes = Array.from(
      node.querySelectorAll<SVGGElement>(
        '.jp-jupyterlab-lightcone-Pipeline-node'
      )
    );
    expect(nodes.map(item => [item.dataset.kind, kindOf(item)])).toEqual([
      ['input', ['input']],
      ['output', ['output']]
    ]);
    expect(
      nodes.every(item =>
        item.querySelector(
          'foreignObject.jp-jupyterlab-lightcone-Pipeline-kind'
        )
      )
    ).toBe(true);
    // The header counts inputs and outputs behind the same marks.
    const header = node.querySelector(
      '.jp-jupyterlab-lightcone-Pipeline-header p'
    );
    expect(header && kindOf(header)).toEqual(['input', 'output']);
    expect(header?.textContent).toContain('1 input');
    expect(header?.textContent).toContain('1 output');
  } finally {
    Widget.detach(widget);
    widget.dispose();
    contents.dispose();
  }
});

const CHAIN = `version: "0.0.14"
name: Chain project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
  - id: covariance
    type: data
    source: data/cov.npz
  - id: calibration
    type: data
    source: data/calibration.csv
outputs:
  - id: fit
    type: metric
    format: json
    inputs: [catalog, covariance]
  - id: plot
    type: figure
    format: png
    inputs: [fit]
  - id: offsets
    type: table
    format: csv
    inputs: [calibration]
`;

/** A pipeline of the chain project, attached, with its open-record calls. */
async function chain(focus?: string) {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(CHAIN) });
  const commands = new CommandRegistry();
  const opened: unknown[] = [];
  commands.addCommand(CommandIDs.openElement, {
    execute: args => {
      opened.push(args);
    }
  });
  const widget = new PipelineWidget(
    ENTRYPOINT,
    contents,
    new FakeThemeManager(),
    commands,
    focus
  );
  Widget.attach(widget, document.body);
  await until(
    () =>
      widget.node.querySelectorAll('.jp-jupyterlab-lightcone-Pipeline-node')
        .length === 6
  );
  const node = (path: string) =>
    Array.from(
      widget.node.querySelectorAll<SVGGElement>(
        '.jp-jupyterlab-lightcone-Pipeline-node'
      )
    ).find(item => item.dataset.path === path)!;
  const trace = () =>
    widget.node.querySelector('.jp-jupyterlab-lightcone-Pipeline-trace');
  const dimmed = () =>
    Array.from(
      widget.node.querySelectorAll<SVGGElement>(
        '.jp-jupyterlab-lightcone-Pipeline-node[data-dimmed]'
      ),
      item => item.dataset.path
    ).sort();
  return {
    widget,
    opened,
    node,
    trace,
    dimmed,
    dispose: () => {
      Widget.detach(widget);
      widget.dispose();
      contents.dispose();
    }
  };
}

test('a traced record lights its lineage and says what it is made from and feeds', async () => {
  const view = await chain('outputs.fit');
  try {
    const fit = view.node('outputs.fit');
    expect(fit.hasAttribute('data-traced')).toBe(true);
    expect(fit.getAttribute('aria-current')).toBe('true');
    // The calibration branch has nothing to do with the fit.
    expect(view.dimmed()).toEqual(['inputs.calibration', 'outputs.offsets']);
    expect(view.trace()?.querySelector('p')?.textContent).toBe(
      'Tracing ◆ fit · made from 2 inputs · feeds 1 output'
    );
    // The traced record carries the inventory's kind mark.
    expect(
      view
        .trace()
        ?.querySelector('.astra-kind-glyph')
        ?.getAttribute('data-kind')
    ).toBe('output');
    const lit = Array.from(
      view.widget.node.querySelectorAll('path[data-highlighted]')
    );
    expect(lit).toHaveLength(3);
  } finally {
    view.dispose();
  }
});

test('Show everything and Escape clear the trace', async () => {
  const view = await chain('inputs.calibration');
  const changes: (string | undefined)[] = [];
  view.widget.focusChanged.connect((_, path) => changes.push(path));
  try {
    expect(view.trace()?.querySelector('p')?.textContent).toBe(
      'Tracing ▤ calibration · feeds 1 output'
    );
    view.trace()!.querySelector('button')!.click();
    await until(() => !view.trace());
    expect(view.widget.focus).toBeUndefined();
    expect(view.dimmed()).toEqual([]);
    view.widget.setFocus('outputs.plot', true);
    await until(() => !!view.trace());
    expect(view.trace()?.textContent).toContain(
      'made from 2 inputs and 1 output · feeds no other output'
    );
    view
      .node('outputs.plot')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    await until(() => !view.trace());
    expect(changes).toEqual([undefined, 'outputs.plot', undefined]);
  } finally {
    view.dispose();
  }
});

test('opening a node from the graph traces it and opens its record', async () => {
  const view = await chain();
  try {
    expect(view.trace()).toBeNull();
    view
      .node('outputs.plot')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await until(() => view.opened.length === 1);
    expect(view.opened[0]).toMatchObject({
      entrypoint: ENTRYPOINT,
      target: 'outputs.plot',
      newTab: false
    });
    expect(view.widget.focus).toBe('outputs.plot');
    await until(() => !!view.trace());
  } finally {
    view.dispose();
  }
});

test('a trace asked for from outside scrolls its node into the middle', async () => {
  const view = await chain();
  const scroller = view.widget.node.querySelector<HTMLElement>(
    '.jp-jupyterlab-lightcone-Pipeline-scroll'
  )!;
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height }) as DOMRect;
  scroller.getBoundingClientRect = () => rect(0, 0, 100, 100);
  view.node('outputs.plot').getBoundingClientRect = () =>
    rect(300, 200, 200, 50);
  try {
    view.widget.setFocus('outputs.plot', true);
    await until(() => scroller.scrollLeft !== 0);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([350, 175]);
    // A click in the graph traces without moving the view.
    scroller.scrollLeft = 10;
    scroller.scrollTop = 10;
    view
      .node('inputs.catalog')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await until(() => view.widget.focus === 'inputs.catalog');
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([10, 10]);
  } finally {
    view.dispose();
  }
});

test('a trace of a record that left the project shows everything', async () => {
  const view = await chain('outputs.gone');
  try {
    expect(view.trace()).toBeNull();
    expect(view.dimmed()).toEqual([]);
  } finally {
    view.dispose();
  }
});

test('pipeline tabs from different projects receive project labels', async () => {
  const { contents } = createContents({});
  const tabs = ['hubble', 'bao'].map(
    project =>
      new MainAreaWidget({
        content: new PipelineWidget(
          `${project}/astra.yaml`,
          contents,
          new FakeThemeManager(),
          new CommandRegistry()
        )
      })
  );
  const layoutModified = new Signal<ILabShell, void>({} as ILabShell);
  const shell = {
    widgets: () => tabs[Symbol.iterator](),
    layoutModified
  } as unknown as ILabShell;
  const labels = new TabProjectLabels(shell, contents, null);
  try {
    await until(() =>
      tabs.every(tab => !!tab.title.dataset[TAB_PROJECT_DATASET_KEY])
    );
    expect(tabs.map(tab => tab.title.dataset[TAB_PROJECT_DATASET_KEY])).toEqual(
      ['hubble', 'bao']
    );
    expect(tabs.map(tab => tab.title.label)).toEqual(['Pipeline', 'Pipeline']);
  } finally {
    labels.dispose();
    tabs.forEach(tab => tab.dispose());
    contents.dispose();
  }
});
