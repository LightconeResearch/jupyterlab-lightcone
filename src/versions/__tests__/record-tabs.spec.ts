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
