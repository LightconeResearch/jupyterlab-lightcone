import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  commandCandidates,
  fileCandidates,
  isSurfaceKind,
  recordCandidates,
  sessionCandidates
} from '../search-candidates';

const TRANS = nullTranslator.load('jupyterlab_lightcone');
const HOUR = 3_600_000;
/** An ISO time `ms` before now, for the relative times captions carry. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const spec = `version: '0.0.14'
name: Project
inputs:
  - id: catalog
    type: data
    description: Original data
outputs:
  - id: fit
    label: Cosmology fit
    type: metric
    format: json
decisions:
  range:
    label: Fitting range
    default: narrow
    options:
      narrow: '48–152'
      wide: '40–160'
prior_insights:
  source:
    claim: Earlier result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: paper
        doi: 10.1234/example
findings:
  result:
    claim: Our result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: measurement
        artifact: fit
`;

function session(overrides: Partial<ISessionInfo> = {}): ISessionInfo {
  return {
    path: 'work/chats/hubble.chat',
    title: 'Hubble diagram with error bars',
    modified: ago(2 * HOUR),
    messages: 4,
    lastAgent: 'Codex',
    activity: 'idle',
    ...overrides
  };
}

describe('sessionCandidates', () => {
  it('labels sessions by title with the subtitle Home shows as the caption', () => {
    const [idle, working, anonymous, undated] = sessionCandidates(
      [
        session(),
        session({
          path: 'work/chats/contours.chat',
          title: 'Contour styling',
          activity: 'working',
          modified: ago(0)
        }),
        session({ path: 'work/chats/untitled.chat', lastAgent: null }),
        session({ path: 'work/chats/undated.chat', modified: 'unknown' })
      ],
      TRANS
    );
    expect(idle).toMatchObject({
      id: 'session:work/chats/hubble.chat',
      kind: 'session',
      category: 'Sessions',
      label: 'Hubble diagram with error bars',
      caption: 'Codex · 2 hours ago',
      rank: 0,
      action: { type: 'session', path: 'work/chats/hubble.chat' }
    });
    expect(working.caption).toBe('Codex · working · now');
    expect(working.rank).toBe(1);
    expect(anonymous.caption).toBe('2 hours ago');
    expect(undated.caption).toBe('Codex');
  });

  it("prefers the workbench's live activity, including a session waiting for input", () => {
    const live: Record<string, 'working' | 'idle' | 'attention'> = {
      'work/chats/hubble.chat': 'attention',
      'work/chats/done.chat': 'idle'
    };
    const [waiting, finished] = sessionCandidates(
      [
        session(),
        session({ path: 'work/chats/done.chat', activity: 'working' })
      ],
      TRANS,
      { activity: path => live[path] }
    );
    expect(waiting.caption).toBe('Codex · needs your input · 2 hours ago');
    expect(finished.caption).toBe('Codex · 2 hours ago');
  });

  it('keeps only the newest sessions up to the limit', () => {
    const many = Array.from({ length: 5 }, (_value, index) =>
      session({ path: `work/chats/${index}.chat`, title: `Session ${index}` })
    );
    expect(sessionCandidates(many, TRANS, { limit: 2 })).toHaveLength(2);
    expect(sessionCandidates(many, TRANS)).toHaveLength(5);
  });
});

describe('recordCandidates', () => {
  it('lists every record by title with its canonical path, then cited papers', async () => {
    const { contents } = createContents({ 'work/astra.yaml': fileModel(spec) });
    try {
      const { bundle } = await resolveProject(contents, 'work/astra.yaml');
      const data = assembleLoadedProject(bundle, {});
      const candidates = recordCandidates(data, 'work/astra.yaml', TRANS);
      const byId = new Map(
        candidates.map(candidate => [candidate.id, candidate])
      );
      expect(byId.get('record:outputs.fit')).toMatchObject({
        kind: 'output',
        category: 'Results',
        label: 'Cosmology fit',
        caption: 'outputs.fit',
        action: {
          type: 'record',
          entrypoint: 'work/astra.yaml',
          target: 'outputs.fit'
        }
      });
      expect(byId.get('record:inputs.catalog')).toMatchObject({
        category: 'Inputs',
        label: 'catalog',
        caption: 'inputs.catalog'
      });
      expect(byId.get('record:decisions.range')).toMatchObject({
        category: 'Decisions',
        label: 'Fitting range'
      });
      expect(byId.get('record:findings.result')?.category).toBe('Findings');
      expect(byId.get('record:prior_insights.source')?.category).toBe(
        'Findings'
      );
      const paper = candidates.find(candidate => candidate.kind === 'paper');
      expect(paper).toMatchObject({
        category: 'Papers',
        action: {
          type: 'paper',
          entrypoint: 'work/astra.yaml',
          doi: '10.1234/example'
        }
      });
      expect(paper?.caption).toContain('10.1234/example');
      // Ranks follow document order and stay unique.
      expect(candidates.map(candidate => candidate.rank)).toEqual(
        candidates.map((_candidate, index) => index)
      );
      expect(candidates.every(candidate => isSurfaceKind(candidate.kind))).toBe(
        true
      );
    } finally {
      contents.dispose();
    }
  });
});

describe('fileCandidates', () => {
  it('shows the file name with its folder and resolves an icon per path', () => {
    const icon = { render: () => undefined };
    const [root, nested] = fileCandidates(
      [
        { path: 'work/README.md', name: 'README.md', directory: '' },
        { path: 'work/src/plot.py', name: 'plot.py', directory: 'src' }
      ],
      TRANS,
      path => (path.endsWith('.py') ? icon : undefined)
    );
    expect(root).toMatchObject({
      id: 'file:work/README.md',
      kind: 'file',
      category: 'Files',
      label: 'README.md',
      caption: '',
      rank: 0,
      action: { type: 'file', path: 'work/README.md' }
    });
    expect(root.icon).toBeUndefined();
    expect(nested).toMatchObject({ caption: 'src', rank: 1, icon });
    expect(isSurfaceKind(root.kind)).toBe(false);
  });
});

describe('commandCandidates', () => {
  function registry() {
    const commands = new CommandRegistry();
    let enabled = true;
    commands.addCommand('jupyterlab_lightcone:open-inventory', {
      label: 'ASTRA Inventory',
      caption: 'Open the inventory',
      describedBy: {
        args: { type: 'object', properties: { path: { type: 'string' } } }
      },
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:create-project', {
      label: 'Create project',
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:open-element', {
      label: 'Open ASTRA element',
      describedBy: {
        args: {
          type: 'object',
          required: ['entrypoint', 'target'],
          properties: {}
        }
      },
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:pin-element', {
      label: 'Pin ASTRA tab',
      isEnabled: () => enabled,
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:hidden', {
      label: 'Hidden',
      isVisible: () => false,
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:unlabelled', {
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:search', {
      label: 'Search',
      execute: () => undefined
    });
    commands.addCommand('docmanager:open', {
      label: 'Open',
      execute: () => undefined
    });
    return { commands, disable: () => (enabled = false) };
  }

  it('keeps labelled Lightcone commands that run without arguments, sorted by label', async () => {
    const { commands, disable } = registry();
    const candidates = await commandCandidates(commands, TRANS, {
      exclude: ['jupyterlab_lightcone:search']
    });
    expect(candidates.map(candidate => candidate.action)).toEqual([
      { type: 'command', id: 'jupyterlab_lightcone:open-inventory' },
      { type: 'command', id: 'jupyterlab_lightcone:create-project' },
      { type: 'command', id: 'jupyterlab_lightcone:pin-element' }
    ]);
    expect(candidates.map(candidate => candidate.rank)).toEqual([0, 1, 2]);
    expect(candidates[0]).toMatchObject({
      id: 'command:jupyterlab_lightcone:open-inventory',
      kind: 'command',
      category: 'Commands',
      label: 'ASTRA Inventory',
      caption: 'Open the inventory'
    });
    const pin = candidates[2];
    expect(pin.isEnabled?.()).toBe(true);
    disable();
    expect(pin.isEnabled?.()).toBe(false);
  });
});
