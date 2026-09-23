import { MainAreaWidget, type IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { createFileContext } from '@jupyterlab/docregistry/lib/testutils';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { InventoryDocument } from '../../document-widget';
import { ElementWidget } from '../../element-widget';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  analysisCountsLabel,
  analysisRows,
  describeWidget,
  listOutputs,
  outputKindLabel,
  projectLabel,
  relativeTime,
  renamedSessionPath,
  resultsSummaryLabel,
  sessionMarker,
  shortcutLabel,
  summarizeResults,
  viewChanges
} from '../sidebar-helpers';
import { PROJECT_SPEC } from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

async function loadProject() {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC)
  });
  try {
    const { bundle } = await resolveProject(contents, 'project/astra.yaml');
    return assembleLoadedProject(bundle, {});
  } finally {
    contents.dispose();
  }
}

describe('relativeTime', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');

  it('rounds down to the largest unit that fits', () => {
    expect(relativeTime('2026-09-23T11:59:30Z', now)).toBe('now');
    expect(relativeTime('2026-09-23T11:59:00Z', now)).toBe('1 min');
    expect(relativeTime('2026-09-23T11:15:00Z', now)).toBe('45 min');
    expect(relativeTime('2026-09-23T09:10:00Z', now)).toBe('2 h');
    expect(relativeTime('2026-09-22T11:00:00Z', now)).toBe('1 day');
    expect(relativeTime('2026-09-20T12:00:00Z', now)).toBe('3 days');
    expect(relativeTime('2026-09-09T12:00:00Z', now)).toBe('2 wk');
    expect(relativeTime('2026-06-23T12:00:00Z', now)).toBe('3 mo');
    expect(relativeTime('2024-09-23T12:00:00Z', now)).toBe('2 yr');
  });

  it('never shows the future or garbage', () => {
    expect(relativeTime('2026-09-24T12:00:00Z', now)).toBe('now');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('sessionMarker', () => {
  it('prefers the live state of an open chat over the server report', () => {
    expect(sessionMarker(undefined, 'working')).toBe('working');
    expect(sessionMarker('attention', 'idle')).toBe('attention');
    expect(sessionMarker('idle', 'working')).toBe('idle');
  });
});

describe('results summary', () => {
  it('lists the results Home shows: active outputs of the root analysis', async () => {
    const data = await loadProject();
    const outputs = listOutputs(data);
    // Neither the output the universe does not make nor the child analysis's.
    expect(outputs.map(output => output.canonicalPath)).toEqual([
      'outputs.hubble_diagram',
      'outputs.cosmology_fit'
    ]);
    expect(
      data.index.recordByPath.get('outputs.curvature_posterior')
    ).toMatchObject({ active: false });
    expect(data.index.recordByPath.has('systematics.outputs.residuals')).toBe(
      true
    );
    expect(outputs.map(output => outputKindLabel(output.type))).toEqual([
      'Figure',
      'Table'
    ]);
  });

  it('counts outputs per state and labels the header', async () => {
    const data = await loadProject();
    const outputs = listOutputs(data);
    const summary = summarizeResults(outputs, output =>
      output.canonicalPath === 'outputs.cosmology_fit'
        ? { state: 'behind', detail: '' }
        : undefined
    );
    expect(summary).toEqual({
      total: 2,
      current: 0,
      behind: 1,
      stale: 0,
      unknown: 1
    });
    expect(resultsSummaryLabel(summary)).toBe('1 behind');
    expect(
      resultsSummaryLabel(
        summarizeResults(outputs, output =>
          output.canonicalPath === 'outputs.hubble_diagram'
            ? { state: 'current' }
            : { state: 'behind' }
        )
      )
    ).toBe('1 ✓ · 1 behind');
    expect(
      resultsSummaryLabel(summarizeResults(outputs, () => undefined))
    ).toBe('2');
    expect(
      resultsSummaryLabel(
        summarizeResults(outputs, () => ({ state: 'current' }))
      )
    ).toBe('2 ✓');
    expect(
      resultsSummaryLabel(summarizeResults(outputs, () => ({ state: 'stale' })))
    ).toBe('2 stale');
    expect(resultsSummaryLabel(summarizeResults([], () => undefined))).toBe(
      '0'
    );
  });
});

describe('analysis rows', () => {
  it('flattens the analysis tree with counts, root first', async () => {
    const data = await loadProject();
    const rows = analysisRows(data);
    expect(rows.map(row => [row.canonicalPath, row.depth])).toEqual([
      ['$', 0],
      ['systematics', 1]
    ]);
    // Every declared output counts, as in the inventory's sections.
    expect(rows[0]).toMatchObject({
      title: 'Sidebar project',
      outputs: 3,
      decisions: 1,
      inputs: 1,
      findings: 1,
      papers: 1
    });
    expect(analysisCountsLabel(rows[0])).toBe(
      'Outputs 3 · Decisions 1 · Inputs 1 · Findings 1 · Papers 1'
    );
    // A child analysis with only outputs is not empty.
    expect(analysisCountsLabel(rows[1])).toBe('Outputs 1');
    expect(rows[1].title).toBe('Systematics');
    expect(
      analysisCountsLabel({
        ...rows[1],
        outputs: 0
      })
    ).toBe('No records yet');
  });
});

describe('projectLabel', () => {
  it('uses the spec name, then the folder, then the root', async () => {
    const data = await loadProject();
    const project = { path: 'project', entrypoint: 'project/astra.yaml' };
    expect(projectLabel(project, data)).toBe('Sidebar project');
    expect(projectLabel(project, undefined)).toBe('project');
    expect(
      projectLabel({ path: '', entrypoint: 'astra.yaml' }, undefined)
    ).toBe('/');
  });
});

describe('describeWidget', () => {
  it('recognizes chat documents, record tabs and inventories structurally', () => {
    expect(describeWidget(null)).toEqual({});
    expect(describeWidget(new Widget())).toEqual({});

    const chat = Object.assign(new Widget(), {
      context: { path: 'project/chats/hubble.chat' }
    });
    expect(describeWidget(chat)).toEqual({
      session: 'project/chats/hubble.chat'
    });

    const inventory = Object.assign(new Widget(), {
      context: { path: 'project/astra.yaml' },
      content: { analysisPath: undefined as string | undefined }
    });
    inventory.addClass('jp-jupyterlab-lightcone-Document');
    expect(describeWidget(inventory)).toEqual({
      inventory: 'project/astra.yaml'
    });
    // Once loaded, the inventory names the analysis it shows.
    inventory.content.analysisPath = 'systematics';
    expect(describeWidget(inventory)).toEqual({
      inventory: 'project/astra.yaml',
      analysisPath: 'systematics'
    });

    const record = Object.assign(new Widget(), {
      content: {
        reference: {
          entrypoint: 'project/astra.yaml',
          target: 'outputs.hubble_diagram',
          universeId: null
        }
      }
    });
    record.title.dataset = { 'lightcone-element': record.id };
    expect(describeWidget(record)).toEqual({
      record: {
        entrypoint: 'project/astra.yaml',
        target: 'outputs.hubble_diagram'
      }
    });

    // A document that is neither a chat nor an inventory is not a view.
    const notebook = Object.assign(new Widget(), {
      context: { path: 'project/analysis.ipynb' }
    });
    expect(describeWidget(notebook)).toEqual({});
  });
});

describe('viewChanges', () => {
  it('names the signals that change a view in place', () => {
    const pathChanged = new Signal<object, string>({});
    const historyChanged = new Signal<object, void>({});
    const scopeChanged = new Signal<object, void>({});
    expect(viewChanges(null)).toEqual([]);
    expect(viewChanges(new Widget())).toEqual([]);

    const chat = Object.assign(new Widget(), {
      context: { path: 'project/chats/hubble.chat', pathChanged }
    });
    expect(viewChanges(chat)).toEqual([pathChanged]);

    const record = Object.assign(new Widget(), {
      content: { reference: {}, historyChanged }
    });
    expect(viewChanges(record)).toEqual([]);
    record.title.dataset = { 'lightcone-element': record.id };
    expect(viewChanges(record)).toEqual([historyChanged]);

    const inventory = Object.assign(new Widget(), {
      context: { path: 'project/astra.yaml', pathChanged },
      content: { scopeChanged }
    });
    inventory.addClass('jp-jupyterlab-lightcone-Document');
    expect(viewChanges(inventory)).toEqual([pathChanged, scopeChanged]);
  });
});

// The checks above are structural; these hold them to the real widgets, so a
// renamed member or dataset key fails here rather than in the running app.
describe('the widgets the sidebar recognizes', () => {
  it('describes and follows a real record tab', () => {
    const { contents } = createContents({});
    const content = new ElementWidget(
      {
        entrypoint: 'project/astra.yaml',
        target: 'outputs.hubble_diagram',
        doi: '10.1234/abc'
      },
      contents,
      new FakeThemeManager(),
      new CommandRegistry(),
      'identity',
      'lightcone-element-test'
    );
    const tab = new MainAreaWidget({ content });
    try {
      expect(describeWidget(tab)).toEqual({
        record: {
          entrypoint: 'project/astra.yaml',
          target: 'outputs.hubble_diagram',
          doi: '10.1234/abc'
        }
      });
      expect(viewChanges(tab)).toEqual([content.historyChanged]);
    } finally {
      tab.dispose();
      contents.dispose();
    }
  });

  it('describes and follows a real inventory document', () => {
    const { contents } = createContents({});
    const context = createFileContext('project/astra.yaml');
    const inventory = new InventoryDocument(
      context,
      contents,
      new FakeThemeManager(),
      new CommandRegistry()
    );
    try {
      // The project has not loaded, so no analysis is shown yet.
      expect(describeWidget(inventory)).toEqual({
        inventory: 'project/astra.yaml'
      });
      expect(viewChanges(inventory)).toEqual([
        context.pathChanged,
        inventory.content.scopeChanged
      ]);
    } finally {
      inventory.dispose();
      context.dispose();
      contents.dispose();
    }
  });
});

describe('renamedSessionPath', () => {
  it('slugs the name in the same folder and drive', () => {
    expect(
      renamedSessionPath('project/chats/untitled-2.chat', 'Hubble fit, v2')
    ).toBe('project/chats/hubble-fit-v2.chat');
    expect(renamedSessionPath('project/chats/a.chat', ' Final.CHAT ')).toBe(
      'project/chats/final.chat'
    );
    expect(renamedSessionPath('archive:old.chat', 'New')).toBe(
      'archive:new.chat'
    );
    expect(renamedSessionPath('old.chat', 'new.chat')).toBe('new.chat');
  });

  it('changes nothing for a blank or identical name', () => {
    expect(renamedSessionPath('project/chats/a.chat', '   ')).toBeUndefined();
    expect(renamedSessionPath('project/chats/a.chat', '.chat')).toBeUndefined();
    expect(renamedSessionPath('project/chats/a.chat', 'A')).toBeUndefined();
    // Accepting the dialog's text unchanged keeps a name that is not a slug.
    expect(
      renamedSessionPath('project/chats/Hubble Fit.chat', 'Hubble Fit')
    ).toBeUndefined();
    expect(
      renamedSessionPath('project/chats/Hubble Fit.chat', 'Hubble Fit v2')
    ).toBe('project/chats/hubble-fit-v2.chat');
  });
});

describe('shortcutLabel', () => {
  it('formats the first binding of a command and hides unbound ones', () => {
    const commands = new CommandRegistry();
    commands.addCommand('test:search', { execute: () => undefined });
    expect(shortcutLabel(commands, 'test:search')).toBeUndefined();
    commands.addKeyBinding({
      command: 'test:search',
      keys: ['Accel K'],
      selector: 'body'
    });
    expect(shortcutLabel(commands, 'test:search')).toBe(
      CommandRegistry.formatKeystroke('Accel K')
    );
  });
});
