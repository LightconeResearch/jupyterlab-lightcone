import { CommandRegistry } from '@lumino/commands';
import {
  countRecords,
  formatRelativeTime,
  groupLauncherItems,
  homeMode,
  isLightconeCategory,
  LAUNCHER_CATEGORY,
  launcherCategory,
  orderPlates,
  outputKindLabel,
  platePreview,
  sessionActivity,
  sessionSubtitle,
  summarizeFreshness
} from '../home-model';
import {
  knownPersona,
  mergePersonas,
  parsePersonas,
  PERSONAS_EVENT_SCHEMA_ID
} from '../personas';

const NOW = new Date('2026-09-23T12:00:00Z');

describe('homeMode', () => {
  const project = { path: 'p', entrypoint: 'p/astra.yaml' };

  it('shows Home only inside a project that did not ask for the stock view', () => {
    expect(homeMode(project, false)).toBe('home');
    expect(homeMode(project, true)).toBe('stock');
    expect(homeMode(null, false)).toBe('stock');
    expect(homeMode(undefined, false)).toBe('stock');
  });
});

describe('formatRelativeTime', () => {
  const at = (iso: string) => formatRelativeTime(iso, NOW);

  it('rounds to the coarsest useful unit', () => {
    expect(at('2026-09-23T11:59:50Z')).toBe('just now');
    expect(at('2026-09-23T11:58:00Z')).toBe('2 min ago');
    expect(at('2026-09-23T09:00:00Z')).toBe('3 h ago');
    expect(at('2026-09-22T12:00:00Z')).toBe('yesterday');
    expect(at('2026-09-21T12:00:00Z')).toBe('2 days ago');
    expect(at('2026-09-09T12:00:00Z')).toBe('2 weeks ago');
    expect(at('2026-07-23T12:00:00Z')).toBe('2 months ago');
    expect(at('2024-09-23T12:00:00Z')).toBe('2 years ago');
  });

  it('counts whole periods, as the sidebar does', () => {
    expect(at('2026-09-22T21:10:00Z')).toBe('14 h ago');
    expect(at('2026-09-20T02:00:00Z')).toBe('3 days ago');
    expect(at('2026-08-25T12:00:00Z')).toBe('4 weeks ago');
  });

  it('accepts dates and rejects unparsable input', () => {
    expect(formatRelativeTime(new Date('2026-09-23T11:00:00Z'), NOW)).toBe(
      '1 h ago'
    );
    expect(formatRelativeTime('not a date', NOW)).toBe('');
  });
});

describe('groupLauncherItems', () => {
  function registry(): CommandRegistry {
    const commands = new CommandRegistry();
    commands.addCommand('notebook:create-new', {
      label: args => String(args.kernelName ?? 'Notebook'),
      execute: () => undefined
    });
    commands.addCommand('console:create', {
      label: args => String(args.kernelName ?? 'Console'),
      execute: () => undefined
    });
    commands.addCommand('terminal:create-new', {
      label: 'Terminal',
      execute: () => undefined
    });
    commands.addCommand('fileeditor:create-new', {
      label: 'Text File',
      execute: () => undefined
    });
    commands.addCommand('jupyterlab_lightcone:open-inventory', {
      label: 'ASTRA Inventory',
      execute: () => undefined
    });
    return commands;
  }

  it('orders categories as the stock launcher does and items by rank then label', () => {
    const groups = groupLauncherItems(
      [
        { command: 'terminal:create-new', category: 'Other', rank: 2 },
        { command: 'fileeditor:create-new', category: 'Other', rank: 1 },
        {
          command: 'console:create',
          category: 'Console',
          args: { kernelName: 'Python 3' }
        },
        {
          command: 'notebook:create-new',
          category: 'Notebook',
          args: { kernelName: 'Python 3' }
        },
        {
          command: 'notebook:create-new',
          category: 'Notebook',
          args: { kernelName: 'BiFlow' }
        },
        { command: 'terminal:create-new', category: 'Zed', categoryRank: 10 }
      ],
      registry(),
      'work'
    );
    expect(groups.map(group => group.category)).toEqual([
      'Notebook',
      'Zed',
      'Console',
      'Other'
    ]);
    expect(groups[0].items.map(item => item.args?.kernelName)).toEqual([
      'BiFlow',
      'Python 3'
    ]);
    expect(groups[3].items.map(item => item.command)).toEqual([
      'fileeditor:create-new',
      'terminal:create-new'
    ]);
  });

  it('falls back to Other, honours the exclusion and uses the caller labels', () => {
    const groups = groupLauncherItems(
      [
        { command: 'terminal:create-new' },
        {
          command: 'jupyterlab_lightcone:open-inventory',
          category: launcherCategory('p')
        }
      ],
      registry(),
      '',
      {
        labels: { notebook: 'Cahier', console: 'Console', other: 'Autre' },
        exclude: item => isLightconeCategory(item.category)
      }
    );
    expect(groups).toEqual([
      { category: 'Autre', items: [{ command: 'terminal:create-new' }] }
    ]);
  });
});

describe('launcher categories', () => {
  it('names the cards outside and inside a project', () => {
    expect(launcherCategory(null)).toBe(LAUNCHER_CATEGORY);
    expect(launcherCategory('')).toBe('Lightcone Lab · /');
    expect(launcherCategory('work/hubble')).toBe('Lightcone Lab · work/hubble');
  });

  it('recognizes exactly the categories Lightcone produces', () => {
    expect(isLightconeCategory(launcherCategory(null))).toBe(true);
    expect(isLightconeCategory(launcherCategory(''))).toBe(true);
    expect(isLightconeCategory(launcherCategory('p'))).toBe(true);
    expect(isLightconeCategory('Lightcone Labs Extras')).toBe(false);
    expect(isLightconeCategory('Lightcone Laboratory')).toBe(false);
    expect(isLightconeCategory('Other')).toBe(false);
    expect(isLightconeCategory(undefined)).toBe(false);
  });
});

describe('summarizeFreshness', () => {
  it('describes an empty project', () => {
    expect(summarizeFreshness([], undefined, NOW)).toEqual({
      state: 'empty',
      text: 'No results yet'
    });
  });

  it('counts results while the status is unknown', () => {
    expect(
      summarizeFreshness(
        [
          { id: 'a', status: undefined },
          { id: 'b', status: undefined }
        ],
        '2026-09-21T12:00:00Z',
        NOW
      )
    ).toEqual({
      state: 'unknown',
      text: '2 results · last materialized 2 days ago'
    });
    expect(summarizeFreshness([{ id: 'a', status: undefined }]).text).toBe(
      '1 result'
    );
  });

  it('reports every result current with the newest run', () => {
    expect(
      summarizeFreshness(
        [
          { id: 'a', status: { state: 'current' } },
          { id: 'b', status: { state: 'current' } }
        ],
        '2026-09-21T12:00:00Z',
        NOW
      )
    ).toEqual({
      state: 'current',
      text: 'All 2 current · last materialized 2 days ago'
    });
  });

  it('names the outputs that are stale or behind', () => {
    expect(
      summarizeFreshness(
        [
          { id: 'hubble', status: { state: 'current' } },
          { id: 'fit', status: { state: 'stale', detail: 'input changed' } },
          { id: 'grid', status: { state: 'behind' } },
          { id: 'contours', status: undefined }
        ],
        undefined,
        NOW
      )
    ).toEqual({
      state: 'attention',
      text: '2 of 4 current · stale: fit · behind: grid'
    });
  });
});

describe('outputKindLabel', () => {
  it('labels the ASTRA output types and capitalizes unknown ones', () => {
    expect(outputKindLabel('figure')).toBe('Figure');
    expect(outputKindLabel('table')).toBe('Table');
    expect(outputKindLabel('metric')).toBe('Metric');
    expect(outputKindLabel('data')).toBe('Data');
    expect(outputKindLabel('report')).toBe('Report');
    expect(outputKindLabel('model')).toBe('Model');
    expect(outputKindLabel(undefined)).toBe('Output');
  });
});

describe('orderPlates', () => {
  it('puts figures first and keeps the declared order within a kind', () => {
    const outputs = [
      { id: 'fit', type: 'table' },
      { id: 'grid', type: 'data' },
      { id: 'hubble', type: 'figure' },
      { id: 'notes', type: 'report' },
      { id: 'contours', type: 'figure' },
      { id: 'h0', type: 'metric' },
      { id: 'other' }
    ];
    expect(orderPlates(outputs).map(output => output.id)).toEqual([
      'hubble',
      'contours',
      'h0',
      'fit',
      'grid',
      'notes',
      'other'
    ]);
    expect(outputs[0].id).toBe('fit');
  });
});

describe('platePreview', () => {
  it('lists the fields of a one-row table with short values', () => {
    expect(
      platePreview({
        kind: 'table',
        headers: ['model', 'omega_m', 'n_supernovae', 'a_very_long_name'],
        rows: [['curved_lcdm', 0.29131347504573885, 580, null]],
        truncated: true
      })
    ).toEqual({
      kind: 'text',
      text: [
        'model      curved_lcdm',
        'omega_m    0.2913',
        'n_superno… 580',
        'a_very_lo… —'
      ].join('\n'),
      truncated: true
    });
  });

  it('keeps every other preview as it is', () => {
    const tall = { kind: 'table' as const, headers: ['a', 'b', 'c'], rows: [] };
    const narrow = {
      kind: 'table' as const,
      headers: ['a', 'b'],
      rows: [[1, 2]]
    };
    const image = { kind: 'image' as const, url: 'x.png' };
    expect(platePreview(tall)).toBe(tall);
    expect(platePreview(narrow)).toBe(narrow);
    expect(platePreview(image)).toBe(image);
  });
});

describe('countRecords', () => {
  it('counts across nested analyses', () => {
    expect(
      countRecords({
        inputs: [1, 2],
        decisions: [1],
        findings: [],
        analyses: [
          {
            inputs: [1],
            decisions: [1, 2],
            findings: [1],
            analyses: [
              { inputs: [], decisions: [], findings: [1], analyses: [] }
            ]
          }
        ]
      })
    ).toEqual({ decisions: 3, inputs: 3, findings: 2 });
  });
});

describe('session rows', () => {
  const info = {
    path: 'p/chats/hubble.chat',
    title: 'Hubble diagram with error bars',
    modified: '2026-09-23T11:58:00Z',
    messages: 4,
    lastAgent: 'Codex',
    activity: 'idle' as const
  };

  it('prefers the live activity over the server report', () => {
    expect(sessionActivity(info, undefined)).toBe('idle');
    expect(sessionActivity(info, 'attention')).toBe('attention');
    expect(sessionActivity({ ...info, activity: 'working' }, undefined)).toBe(
      'working'
    );
  });

  it('joins the agent, the activity and the age', () => {
    expect(sessionSubtitle(info, 'working', NOW)).toBe(
      'Codex · working · 2 min ago'
    );
    expect(sessionSubtitle(info, 'attention', NOW)).toBe(
      'Codex · needs your input · 2 min ago'
    );
    expect(sessionSubtitle({ ...info, lastAgent: null }, 'idle', NOW)).toBe(
      '2 min ago'
    );
  });
});

describe('mergePersonas', () => {
  const current = [{ id: 'jupyter-ai-personas::codex', name: 'Codex' }];

  it('ignores other events and malformed entries', () => {
    expect(mergePersonas(current, { schema_id: 'other' })).toBeUndefined();
    expect(
      mergePersonas(current, {
        schema_id: PERSONAS_EVENT_SCHEMA_ID,
        personas: [{ id: '', name: 'Nameless' }, { name: 'No id' }, 'text']
      })
    ).toBeUndefined();
  });

  it('adds and renames personas, keeping first-seen order', () => {
    const merged = mergePersonas(current, {
      schema_id: PERSONAS_EVENT_SCHEMA_ID,
      chat_id: 'chat-1',
      personas: [
        { id: 'jupyter-ai-personas::claude', name: 'Claude', avatar_url: null },
        {
          id: 'jupyter-ai-personas::codex',
          name: 'Codex CLI',
          avatar_url: null
        }
      ]
    });
    expect(merged).toEqual([
      { id: 'jupyter-ai-personas::codex', name: 'Codex CLI' },
      { id: 'jupyter-ai-personas::claude', name: 'Claude' }
    ]);
    expect(
      mergePersonas(merged!, {
        schema_id: PERSONAS_EVENT_SCHEMA_ID,
        personas: [{ id: 'jupyter-ai-personas::claude', name: 'Claude' }]
      })
    ).toBeUndefined();
  });
});

describe('parsePersonas', () => {
  it('keeps well-formed entries once, in order', () => {
    expect(
      parsePersonas([
        { id: 'jupyter-ai-personas::codex', name: 'Codex' },
        { id: '', name: 'Nameless' },
        { id: 'jupyter-ai-personas::claude' },
        'text',
        { id: 'jupyter-ai-personas::claude', name: 'Claude' },
        { id: 'jupyter-ai-personas::codex', name: 'Codex again' }
      ])
    ).toEqual([
      { id: 'jupyter-ai-personas::codex', name: 'Codex' },
      { id: 'jupyter-ai-personas::claude', name: 'Claude' }
    ]);
  });

  it('reads anything else as no personas', () => {
    expect(parsePersonas(undefined)).toEqual([]);
    expect(parsePersonas({ id: 'x', name: 'X' })).toEqual([]);
  });
});

describe('knownPersona', () => {
  const personas = [{ id: 'jupyter-ai-personas::codex', name: 'Codex' }];

  it('keeps an advertised persona and falls back to the default otherwise', () => {
    expect(knownPersona(personas, 'jupyter-ai-personas::codex')).toBe(
      'jupyter-ai-personas::codex'
    );
    expect(knownPersona(personas, 'jupyter-ai-personas::gone')).toBe('');
    expect(knownPersona([], 'jupyter-ai-personas::codex')).toBe('');
    expect(knownPersona(personas, '')).toBe('');
  });
});
