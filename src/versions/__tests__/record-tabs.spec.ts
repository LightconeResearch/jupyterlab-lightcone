import React from 'react';
import type { ILayoutRestorer, JupyterFrontEnd } from '@jupyterlab/application';
import type {
  IThemeManager,
  MainAreaWidget,
  WidgetTracker
} from '@jupyterlab/apputils';
import { ContentsManager } from '@jupyterlab/services';
import type { IDataConnector } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import type {
  ReadonlyPartialJSONObject,
  ReadonlyPartialJSONValue
} from '@lumino/coreutils';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../../commands';
import { registerElementCommands } from '../../element-commands';
import type { ElementWidget } from '../../element-widget';
import { ElementHistoryCommandIDs } from '../element-history';

// Record bodies are not under test: their project never loads.
jest.mock('../../project-renderers', () => ({
  useProjectRenderers: jest.fn()
}));
jest.mock('../../project-data-service', () => ({
  acquireProjectDataService: () => ({
    service: {
      state: { data: undefined, error: undefined },
      changed: { connect: () => true, disconnect: () => true },
      get: () => new Promise(() => undefined),
      fetchPaper: async () => undefined
    },
    release: () => undefined
  })
}));

type Tab = MainAreaWidget<ElementWidget>;

function isObject(
  value: ReadonlyPartialJSONValue | undefined
): value is ReadonlyPartialJSONObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const ENTRYPOINT = 'project/astra.yaml';

function identity(target: string): string {
  return JSON.stringify([ENTRYPOINT, target, null]);
}

/** A shell, a restorer and a state database, enough for record tabs. */
function workbench() {
  const commands = new CommandRegistry();
  const owner = {};
  const shell = {
    add: jest.fn(),
    activateById: jest.fn(),
    currentWidget: null,
    currentChanged: new Signal<object, unknown>(owner),
    disposed: new Signal<object, unknown>(owner)
  };
  const contents = new ContentsManager();
  const app = {
    commands,
    shell,
    restored: Promise.resolve(),
    contextMenu: { addItem: () => ({ dispose: () => undefined }) },
    contextMenuHitTest: () => undefined,
    serviceManager: { contents }
  } as unknown as JupyterFrontEnd;
  const saved = new Map<string, ReadonlyPartialJSONValue | undefined>();
  const connector: IDataConnector<ReadonlyPartialJSONValue> = {
    fetch: async id => saved.get(id),
    list: async () => ({ ids: [], values: [] }),
    remove: async id => {
      saved.delete(id);
    },
    save: async (id, value) => {
      saved.set(id, value);
    }
  };
  let tracker: WidgetTracker<Tab> | undefined;
  const restorer = {
    restore: (
      restored: WidgetTracker<Tab>,
      options: Parameters<ILayoutRestorer['restore']>[1]
    ) => {
      tracker = restored;
      return restored.restore({
        ...options,
        connector,
        registry: commands,
        when: Promise.resolve()
      });
    }
  } as unknown as ILayoutRestorer;
  const themes = {
    theme: null,
    isLight: () => true,
    themeChanged: new Signal<object, unknown>(owner)
  } as unknown as IThemeManager;
  registerElementCommands(app, themes, restorer, null);
  return {
    commands,
    shell,
    contents,
    saved,
    tabs: () => {
      const all: Tab[] = [];
      tracker?.forEach(tab => all.push(tab));
      return all;
    },
    /** The arguments a reload would restore a tab with. */
    restoreArgs: (tab: Widget): ReadonlyPartialJSONObject | undefined => {
      const value = saved.get(`lightcone-elements:${tab.id}`);
      return isObject(value) && isObject(value.data) ? value.data : undefined;
    }
  };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function restore(
  commands: CommandRegistry,
  widgetId: string,
  extra: ReadonlyPartialJSONObject = {}
): Promise<void> {
  await commands.execute(CommandIDs.restoreElement, {
    entrypoint: ENTRYPOINT,
    target: 'outputs.fit',
    universeId: null,
    widgetId,
    label: 'Fit',
    ...extra
  });
}

let bench: ReturnType<typeof workbench>;

beforeEach(async () => {
  bench = workbench();
  await settle();
});

afterEach(() => {
  for (const tab of bench.tabs()) tab.dispose();
  bench.contents.dispose();
});

test('two restored tabs showing the same record stay two tabs with their own pins', async () => {
  await restore(bench.commands, 'lightcone-element-one', { pinned: true });
  await restore(bench.commands, 'lightcone-element-two');
  const tabs = bench.tabs();
  expect(tabs.map(tab => tab.id)).toEqual([
    'lightcone-element-one',
    'lightcone-element-two'
  ]);
  expect(tabs.map(tab => tab.content.isPinned)).toEqual([true, false]);
  // Restoring an id that is already open reuses that tab.
  await restore(bench.commands, 'lightcone-element-two');
  expect(bench.tabs()).toHaveLength(2);
});

test('moving through the history and stepping versions is what a reload restores', async () => {
  await restore(bench.commands, 'lightcone-element-one');
  const [tab] = bench.tabs();
  const record = tab.content;
  record.display(
    { entrypoint: ENTRYPOINT, target: 'decisions.model', universeId: null },
    identity('decisions.model'),
    'Model'
  );
  await settle();
  expect(bench.restoreArgs(tab)).toMatchObject({
    target: 'decisions.model',
    label: 'Model'
  });
  record.back();
  await settle();
  expect(bench.restoreArgs(tab)).toMatchObject({
    target: 'outputs.fit',
    label: 'Fit'
  });
  record.selectVersion('a889877');
  await settle();
  expect(bench.restoreArgs(tab)).toMatchObject({
    target: 'outputs.fit',
    versionCommit: 'a889877'
  });
  // Forward and back again come back to the stepped version.
  record.forward();
  record.back();
  expect(record.selectedVersion).toBe('a889877');
  record.selectVersion(undefined);
  await settle();
  expect(bench.restoreArgs(tab)?.versionCommit).toBeUndefined();
});

test('a restored tab shows the version it was saved with', async () => {
  await restore(bench.commands, 'lightcone-element-one', {
    versionCommit: 'b'.repeat(40)
  });
  const [tab] = bench.tabs();
  expect(tab.content.selectedVersion).toBe('b'.repeat(40));
  await restore(bench.commands, 'lightcone-element-two', {
    versionCommit: 'not a commit'
  });
  expect(bench.tabs()[1].content.selectedVersion).toBeUndefined();
});

test('a version requested for the record a tab shows replaces its selection', async () => {
  await restore(bench.commands, 'lightcone-element-one');
  const [tab] = bench.tabs();
  const changed = jest.fn();
  tab.content.historyChanged.connect(changed);
  tab.content.display(
    { entrypoint: ENTRYPOINT, target: 'outputs.fit', universeId: null },
    identity('outputs.fit'),
    'Fit',
    { versionCommit: 'c'.repeat(7) }
  );
  expect(tab.content.selectedVersion).toBe('c'.repeat(7));
  expect(tab.content.history.entries).toHaveLength(1);
  expect(changed).toHaveBeenCalled();
  // A reopen that names no version keeps what the reader selected.
  tab.content.display(
    { entrypoint: ENTRYPOINT, target: 'outputs.fit', universeId: null },
    identity('outputs.fit'),
    'Fit'
  );
  expect(tab.content.selectedVersion).toBe('c'.repeat(7));
});

test('"Open in new tab" opens the version the tab shows now', async () => {
  await restore(bench.commands, 'lightcone-element-one', {
    versionCommit: 'c'.repeat(40)
  });
  const [tab] = bench.tabs();
  const execute = bench.commands.execute.bind(bench.commands);
  const opened: ReadonlyPartialJSONObject[] = [];
  jest
    .spyOn(bench.commands, 'execute')
    .mockImplementation(async (id, args = {}) => {
      if (id !== CommandIDs.openElement) return execute(id, args);
      opened.push(args);
      return undefined;
    });
  // "Latest" on the stepper returns the tab to the newest version.
  tab.content.selectVersion(undefined);
  await bench.commands.execute(ElementHistoryCommandIDs.openInNewTab, {
    widgetId: tab.id
  });
  expect(opened[0]).toMatchObject({ target: 'outputs.fit', newTab: true });
  expect(opened[0].versionCommit).toBeUndefined();
  tab.content.selectVersion('a'.repeat(40));
  await bench.commands.execute(ElementHistoryCommandIDs.openInNewTab, {
    widgetId: tab.id
  });
  expect(opened[1].versionCommit).toBe('a'.repeat(40));
});

test('keyboard focus stays in the tab when showing another record replaces the focused control', async () => {
  await restore(bench.commands, 'lightcone-element-one');
  const [tab] = bench.tabs();
  const record = tab.content;
  /** Stand-in body: the Back button of the record shown, remounted per record. */
  jest
    .spyOn(record, 'render')
    .mockImplementation(() =>
      React.createElement('button', { key: record.identity }, 'Back')
    );
  const rendered = async () => {
    MessageLoop.flush();
    await record.renderPromise;
    await settle();
  };
  Widget.attach(tab, document.body);
  try {
    await rendered();
    record.node.querySelector('button')!.focus();
    expect(record.node.contains(document.activeElement)).toBe(true);
    record.display(
      { entrypoint: ENTRYPOINT, target: 'decisions.model', universeId: null },
      identity('decisions.model'),
      'Model'
    );
    await rendered();
    expect(document.activeElement).toBe(record.node);
    // Alt+← is bound to this node, so it keeps working from here.
    record.node.querySelector('button')!.focus();
    record.back();
    await rendered();
    expect(document.activeElement).toBe(record.node);
    expect(record.reference.target).toBe('outputs.fit');
  } finally {
    Widget.detach(tab);
  }
});

test('disposing the record disposes its tab', async () => {
  await restore(bench.commands, 'lightcone-element-one');
  const [tab] = bench.tabs();
  tab.content.dispose();
  expect(tab.isDisposed).toBe(true);
  expect(bench.tabs()).toHaveLength(0);
});
