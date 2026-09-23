import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';
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
  resultsSummaryLabel,
  sessionMarker,
  shortcutLabel,
  summarizeResults
} from '../sidebar-helpers';
import { PROJECT_SPEC } from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

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
  it('counts outputs per state and labels the header', async () => {
    const data = await loadProject();
    const outputs = listOutputs(data.index);
    expect(outputs.map(output => output.canonicalPath)).toEqual([
      'outputs.hubble_diagram',
      'outputs.cosmology_fit',
      'systematics.outputs.residuals'
    ]);
    expect(outputs.map(output => outputKindLabel(output.type))).toEqual([
      'Figure',
      'Table',
      'Data'
    ]);
    const states = {
      'outputs.hubble_diagram': 'current',
      'outputs.cosmology_fit': 'behind'
    } as const;
    const summary = summarizeResults(outputs, output => {
      const state =
        output.canonicalPath in states
          ? states[output.canonicalPath as keyof typeof states]
          : undefined;
      return state ? { state, detail: '' } : undefined;
    });
    expect(summary).toEqual({
      total: 3,
      current: 1,
      behind: 1,
      stale: 0,
      unknown: 1
    });
    expect(resultsSummaryLabel(summary)).toBe('1 ✓ · 1 behind');
    expect(
      resultsSummaryLabel(summarizeResults(outputs, () => undefined))
    ).toBe('3');
    expect(
      resultsSummaryLabel(
        summarizeResults(outputs, () => ({ state: 'current' }))
      )
    ).toBe('3 ✓');
    expect(
      resultsSummaryLabel(summarizeResults(outputs, () => ({ state: 'stale' })))
    ).toBe('3 stale');
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
    expect(rows[0]).toMatchObject({
      title: 'Sidebar project',
      outputs: 2,
      decisions: 1,
      inputs: 1,
      findings: 1,
      papers: 1
    });
    expect(analysisCountsLabel(rows[0])).toBe(
      'Decisions 1 · Inputs 1 · Findings 1 · Papers 1'
    );
    expect(analysisCountsLabel(rows[1])).toBe('No records yet');
    expect(rows[1].title).toBe('Systematics');
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
      context: { path: 'project/astra.yaml' }
    });
    inventory.addClass('jp-jupyterlab-lightcone-Document');
    expect(describeWidget(inventory)).toEqual({
      inventory: 'project/astra.yaml'
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
