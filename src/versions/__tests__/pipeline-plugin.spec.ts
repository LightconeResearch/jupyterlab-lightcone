import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, showErrorMessage } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { DockLayout } from '@lumino/widgets';
import { Widget } from '@lumino/widgets';
import { FakeThemeManager } from './theme-fixtures';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { versionsPlugin } from '..';
import { PipelineCommandIDs } from '../pipeline-commands';
import { PipelineWidget } from '../pipeline-view';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn().mockResolvedValue({ outputs: {} })
}));

const ENTRYPOINT = 'project/astra.yaml';
const SPEC = `version: "0.0.14"
name: Pipeline project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: plot
    type: figure
    format: png
    inputs: [catalog]
`;

/** A record tab: the shell tells it apart by its title's dataset. */
function recordTab(id: string): Widget {
  const widget = new Widget();
  widget.id = id;
  widget.title.dataset = { 'lightcone-element': id };
  return widget;
}

/**
 * Activate the plugin in a fake shell whose main area is `columns`: tab
 * areas from left to right, each showing its first widget, as the shell
 * saves its layout.
 */
function host(columns: Widget[][], current: Widget) {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(SPEC) });
  const areas: DockLayout.AreaConfig[] = columns.map(widgets => ({
    type: 'tab-area',
    widgets,
    currentIndex: 0
  }));
  const dock: DockLayout.ILayoutConfig = {
    main:
      areas.length === 1
        ? areas[0]
        : {
            type: 'split-area',
            orientation: 'horizontal',
            children: areas,
            sizes: areas.map(() => 1)
          }
  };
  const shell = {
    add: jest.fn(),
    activateById: jest.fn(),
    currentWidget: current as Widget | null,
    saveLayout: () => ({ mainArea: { currentWidget: current, dock } })
  };
  const commands = new CommandRegistry();
  const app = {
    commands,
    shell,
    serviceManager: { contents }
  } as unknown as JupyterFrontEnd;
  versionsPlugin.activate(
    app,
    new FakeThemeManager(),
    null,
    null,
    null,
    shell as unknown as ILabShell
  );
  const open = async (args: ReadonlyPartialJSONObject) => {
    const tab: unknown = await commands.execute(
      PipelineCommandIDs.openPipeline,
      args
    );
    if (tab === undefined) return undefined;
    if (!(tab instanceof MainAreaWidget))
      throw new Error('The pipeline command returned something else.');
    const content: unknown = tab.content;
    if (!(content instanceof PipelineWidget))
      throw new Error('The pipeline tab holds something else.');
    return { tab, content };
  };
  return { shell, open, dispose: () => contents.dispose() };
}

beforeEach(() => {
  jest.mocked(showErrorMessage).mockClear();
});

test('from Home, the pipeline opens beside it showing everything', async () => {
  const home = new Widget();
  home.id = 'home';
  const h = host([[home]], home);
  try {
    const opened = await h.open({ entrypoint: `./${ENTRYPOINT}` });
    expect(opened?.content.entrypoint).toBe(ENTRYPOINT);
    expect(opened?.content.focus).toBeUndefined();
    expect(h.shell.add).toHaveBeenCalledWith(opened?.tab, 'main', undefined);
    expect(h.shell.activateById).toHaveBeenCalledWith(opened?.tab.id);
  } finally {
    h.dispose();
  }
});

test('from a record, it traces the record in the column on its left', async () => {
  const home = new Widget();
  home.id = 'home';
  const record = recordTab('lightcone-element-1');
  const h = host([[home], [record]], record);
  try {
    const opened = await h.open({
      entrypoint: ENTRYPOINT,
      focus: 'outputs.plot'
    });
    expect(opened?.content.focus).toBe('outputs.plot');
    expect(h.shell.add).toHaveBeenCalledWith(opened?.tab, 'main', {
      mode: 'tab-after',
      ref: 'home'
    });
  } finally {
    h.dispose();
  }
});

test('from a record alone, it splits to the record’s left', async () => {
  const record = recordTab('lightcone-element-1');
  const h = host([[record]], record);
  try {
    const opened = await h.open({
      entrypoint: ENTRYPOINT,
      focus: 'inputs.catalog'
    });
    expect(h.shell.add).toHaveBeenCalledWith(opened?.tab, 'main', {
      mode: 'split-left',
      ref: 'lightcone-element-1'
    });
  } finally {
    h.dispose();
  }
});

test('an open pipeline retraces in place, and shows everything again without a record', async () => {
  const record = recordTab('lightcone-element-1');
  const h = host([[record]], record);
  try {
    const first = await h.open({ entrypoint: ENTRYPOINT });
    const traced = await h.open({
      entrypoint: ENTRYPOINT,
      focus: 'outputs.plot'
    });
    expect(traced?.tab).toBe(first?.tab);
    expect(h.shell.add).toHaveBeenCalledTimes(1);
    expect(traced?.content.focus).toBe('outputs.plot');
    expect(h.shell.activateById).toHaveBeenLastCalledWith(first?.tab.id);
    const everything = await h.open({ entrypoint: ENTRYPOINT });
    expect(everything?.content.focus).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('without a project, it says so instead of opening', async () => {
  const home = new Widget();
  home.id = 'home';
  const h = host([[home]], home);
  try {
    expect(await h.open({})).toBeUndefined();
    expect(h.shell.add).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Could not open the pipeline',
      expect.objectContaining({
        message: expect.stringContaining('Lightcone project')
      })
    );
  } finally {
    h.dispose();
  }
});
