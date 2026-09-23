import { CommandRegistry } from '@lumino/commands';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  commandCandidates,
  fileCandidates,
  isSurfaceKind,
  recordCandidates,
  relativeTime,
  sessionCandidates,
  sessionCaption
} from '../search-candidates';

const NOW = Date.parse('2026-09-23T12:00:00Z');

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
    modified: '2026-09-23T10:00:00Z',
    messages: 4,
    lastAgent: 'Codex',
    activity: 'idle',
    ...overrides
  };
}

describe('relativeTime', () => {
  it.each([
    ['2026-09-23T11:59:30Z', 'just now'],
    ['2026-09-23T11:35:00Z', '25 min ago'],
    ['2026-09-23T09:00:00Z', '3 h ago'],
    ['2026-09-22T09:00:00Z', 'yesterday'],
    ['2026-09-20T09:00:00Z', '3 days ago'],
    ['2026-09-01T09:00:00Z', '2026-09-01']
  ])('describes %s as %s', (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it('is empty for an unreadable date and never negative', () => {
    expect(relativeTime('later', NOW)).toBe('');
    expect(relativeTime('2026-09-23T13:00:00Z', NOW)).toBe('just now');
  });
});

describe('sessionCandidates', () => {
  it('labels sessions by title with activity, agent and age in the caption', () => {
    const [idle, working, anonymous] = sessionCandidates(
      [
        session(),
        session({
          path: 'work/chats/contours.chat',
          title: 'Contour styling',
          activity: 'working',
          modified: '2026-09-23T11:59:40Z'
        }),
        session({ path: 'work/chats/untitled.chat', lastAgent: null })
      ],
      { now: NOW }
    );
    expect(idle).toMatchObject({
      id: 'session:work/chats/hubble.chat',
      kind: 'session',
      category: 'Sessions',
      label: 'Hubble diagram with error bars',
      caption: 'Codex · 2 h ago',
      rank: 0,
      action: { type: 'session', path: 'work/chats/hubble.chat' }
    });
    expect(working.caption).toBe('working · Codex · just now');
    expect(working.rank).toBe(1);
    expect(anonymous.caption).toBe('2 h ago');
    expect(sessionCaption(session({ modified: 'unknown' }), NOW)).toBe('Codex');
  });

  it('keeps only the newest sessions up to the limit', () => {
    const many = Array.from({ length: 5 }, (_value, index) =>
      session({ path: `work/chats/${index}.chat`, title: `Session ${index}` })
    );
    expect(sessionCandidates(many, { now: NOW, limit: 2 })).toHaveLength(2);
    expect(sessionCandidates(many, { now: NOW })).toHaveLength(5);
  });
});

describe('recordCandidates', () => {
  it('lists every record by title with its canonical path, then cited papers', async () => {
    const { contents } = createContents({ 'work/astra.yaml': fileModel(spec) });
    try {
      const { bundle } = await resolveProject(contents, 'work/astra.yaml');
      const data = assembleLoadedProject(bundle, {});
      const candidates = recordCandidates(data, 'work/astra.yaml');
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
        { path: 'work/README.md', name: 'README.md', directory: '', depth: 1 },
        {
          path: 'work/src/plot.py',
          name: 'plot.py',
          directory: 'src',
          depth: 2
        }
      ],
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
    const candidates = await commandCandidates(commands, {
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

  it('honours a different prefix', async () => {
    const { commands } = registry();
    const candidates = await commandCandidates(commands, {
      prefix: 'docmanager:'
    });
    expect(candidates.map(candidate => candidate.label)).toEqual(['Open']);
  });
});
