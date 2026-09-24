import type { JupyterFrontEnd } from '@jupyterlab/application';
import { WidgetTracker } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { ElementTabs, type ElementTab } from '../../element-tabs';
import { ElementWidget } from '../../element-widget';
import { FakeThemeManager } from '../../home/__tests__/home-fixtures';
import { requestAPI } from '../../request';
import { until } from '../../__tests__/async-fixtures';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { ElementHistoryCommandIDs } from '../element-history';
import { PipelineCommandIDs } from '../pipeline-commands';
import { PIPELINE_TAB_PREFIX } from '../pipeline-placement';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const SPEC = `version: "0.0.14"
name: Record project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
decisions:
  model:
    label: Cosmological model
    options:
      lcdm:
        label: LCDM
    default: lcdm
`;

beforeEach(() => {
  jest.mocked(requestAPI).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return { outputs: {} };
    }
    throw new Error(`Not served in this test: ${endpoint}`);
  });
});

/** A record tab showing `target`, with the commands it runs recorded. */
async function recordTab(target: string, pipeline = true) {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(SPEC) });
  const commands = new CommandRegistry();
  const executed: [string, ReadonlyPartialJSONObject][] = [];
  const ids = [ElementHistoryCommandIDs.back, ElementHistoryCommandIDs.forward];
  if (pipeline) ids.push(PipelineCommandIDs.openPipeline);
  for (const id of ids) {
    commands.addCommand(id, {
      execute: args => {
        executed.push([id, args]);
      }
    });
  }
  const widget = new ElementWidget(
    { entrypoint: ENTRYPOINT, target, universeId: null },
    contents,
    new FakeThemeManager(),
    commands,
    JSON.stringify([ENTRYPOINT, target, null]),
    'lightcone-element-record'
  );
  Widget.attach(widget, document.body);
  await until(() => !!widget.node.querySelector('.astra-dialog__header'));
  const action = () =>
    Array.from(
      widget.node.querySelectorAll<HTMLButtonElement>('.astra-dialog__action')
    ).find(button => button.textContent === 'Show in pipeline');
  return {
    executed,
    action,
    dispose: () => {
      Widget.detach(widget);
      widget.dispose();
      contents.dispose();
    }
  };
}

test.each([['outputs.hubble_diagram'], ['inputs.catalog']])(
  'the %s tab shows its record in the pipeline',
  async target => {
    const tab = await recordTab(target);
    try {
      await until(() => tab.action() !== undefined);
      tab.action()!.click();
      await until(() => tab.executed.length > 0);
      expect(tab.executed).toContainEqual([
        PipelineCommandIDs.openPipeline,
        { entrypoint: ENTRYPOINT, focus: target }
      ]);
    } finally {
      tab.dispose();
    }
  }
);

test('records the pipeline does not draw, or a Lab without it, get no button', async () => {
  const decision = await recordTab('decisions.model');
  try {
    expect(decision.action()).toBeUndefined();
  } finally {
    decision.dispose();
  }
  const bare = await recordTab('outputs.hubble_diagram', false);
  try {
    expect(bare.action()).toBeUndefined();
  } finally {
    bare.dispose();
  }
});

test('a record opened from the pipeline goes beside it, however narrow', () => {
  const pipeline = new Widget();
  pipeline.id = `${PIPELINE_TAB_PREFIX}project-astra-yaml`;
  const plain = new Widget();
  plain.id = 'notes';
  const shell = {
    add: jest.fn(),
    currentWidget: pipeline as Widget | null
  };
  const app = {
    commands: new CommandRegistry(),
    contextMenu: { addItem: () => ({ dispose: () => undefined }) },
    shell,
    restored: new Promise(() => undefined)
  } as unknown as JupyterFrontEnd;
  const tabs = new ElementTabs(
    app,
    null,
    new WidgetTracker<ElementTab>({ namespace: 'record-pipeline-test' })
  );
  try {
    const first = new Widget() as unknown as ElementTab;
    tabs.add(first);
    expect(shell.add).toHaveBeenLastCalledWith(first, 'main', {
      mode: 'split-right',
      ref: pipeline.id,
      activate: true
    });
    // A narrow document keeps its results as tabs beside it.
    shell.currentWidget = plain;
    const second = new Widget() as unknown as ElementTab;
    tabs.add(second);
    expect(shell.add).toHaveBeenLastCalledWith(second, 'main', {
      mode: 'tab-after',
      ref: 'notes',
      activate: true
    });
  } finally {
    tabs.dispose();
  }
});
