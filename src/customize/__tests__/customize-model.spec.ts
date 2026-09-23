import {
  attentionCount,
  attentionSummary,
  customizeSections,
  themeChoices,
  type ICustomizeSection
} from '../customize-model';
import type { ISetupReport, ITool } from '../setup-api';

function tool(
  found: boolean,
  version: string | null = null,
  path: string | null = null
): ITool {
  return { found, version, path };
}

function report(overrides: Partial<ISetupReport> = {}): ISetupReport {
  return {
    jupyterAi: true,
    agents: [
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        executable: {
          name: 'claude-agent-acp',
          found: true,
          path: '/usr/bin/claude-agent-acp'
        }
      },
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        executable: { name: 'codex-acp', found: false, path: null }
      }
    ],
    skills: [
      {
        harness: 'claude',
        name: 'lightcone',
        version: '0.5.0',
        path: '/home/u/.claude/plugins/lightcone',
        found: true
      },
      {
        harness: 'codex',
        name: 'lightcone',
        version: null,
        path: '/home/u/.codex/plugins/lightcone',
        found: false
      }
    ],
    tools: {
      uv: tool(true, '0.8.0', '/usr/bin/uv'),
      git: tool(true, '2.51.0', '/usr/bin/git'),
      'git-annex': tool(true, '10.20250901', '/usr/bin/git-annex'),
      myst: tool(false)
    },
    sandbox: { backend: 'landlock', available: true },
    environment: { lock: true, venv: false },
    instructions: { path: 'project/AGENTS.md', exists: true },
    storage: { annex: true, remotes: ['origin'] },
    ...overrides
  };
}

function section(
  sections: ICustomizeSection[],
  id: ICustomizeSection['id']
): ICustomizeSection {
  const found = sections.find(candidate => candidate.id === id);
  if (!found) {
    throw new Error(`No ${id} section`);
  }
  return found;
}

it('lists the sections in display order', () => {
  expect(customizeSections(report()).map(item => item.id)).toEqual([
    'agents',
    'skills',
    'instructions',
    'environment',
    'tools',
    'boundary',
    'storage'
  ]);
});

it('reports each agent as ready or names what is missing', () => {
  const agents = section(customizeSections(report()), 'agents');
  expect(agents.summary).toContain('Jupyter AI');
  expect(agents.rows).toEqual([
    {
      id: 'claude',
      label: 'Claude Code',
      value: 'Ready',
      detail: '/usr/bin/claude-agent-acp',
      state: 'ok'
    },
    {
      id: 'codex',
      label: 'Codex',
      value: "codex-acp not found on the server's PATH",
      state: 'missing'
    }
  ]);
  const uninstalled = section(
    customizeSections(
      report({
        jupyterAi: false,
        agents: [
          {
            id: 'claude',
            name: 'Claude Code',
            installed: false,
            executable: {
              name: 'claude-agent-acp',
              found: true,
              path: '/usr/bin/claude-agent-acp'
            }
          }
        ]
      })
    ),
    'agents'
  );
  expect(uninstalled.summary).toBe(
    'Jupyter AI is not installed, so sessions are unavailable.'
  );
  expect(uninstalled.rows[0]).toMatchObject({
    value: 'Jupyter AI ACP client not installed',
    detail: 'claude-agent-acp: /usr/bin/claude-agent-acp',
    state: 'missing'
  });
  expect(
    section(customizeSections(report({ agents: [] })), 'agents').rows
  ).toEqual([]);
});

it('labels skills by harness with their version, and flags missing ones', () => {
  const skills = section(customizeSections(report()), 'skills');
  expect(skills.rows).toEqual([
    {
      id: 'claude:lightcone',
      label: 'lightcone',
      value: 'Installed · 0.5.0',
      detail: 'Claude Code · /home/u/.claude/plugins/lightcone',
      state: 'ok'
    },
    {
      id: 'codex:lightcone',
      label: 'lightcone',
      value: 'Not found',
      detail: 'Codex · /home/u/.codex/plugins/lightcone',
      state: 'missing'
    }
  ]);
  expect(
    section(customizeSections(report({ skills: [] })), 'skills').empty
  ).toContain('No Lightcone skill');
});

it('offers Edit only for project instructions that exist', () => {
  const present = section(customizeSections(report()), 'instructions');
  expect(present.rows).toEqual([
    {
      id: 'instructions',
      label: 'AGENTS.md',
      value: 'Present',
      detail: 'project/AGENTS.md',
      state: 'ok',
      action: { kind: 'open-file', label: 'Edit', path: 'project/AGENTS.md' }
    }
  ]);
  const absent = section(
    customizeSections(
      report({ instructions: { path: 'project/AGENTS.md', exists: false } })
    ),
    'instructions'
  );
  expect(absent.rows[0]).toEqual({
    id: 'instructions',
    label: 'AGENTS.md',
    value: 'Not found',
    detail: 'project/AGENTS.md',
    state: 'missing'
  });
  const noProject = section(
    customizeSections(report({ instructions: null })),
    'instructions'
  );
  expect(noProject.rows).toEqual([]);
  expect(noProject.empty).toContain('Open a Lightcone project');
});

it('shows environment, tools, boundary and storage as they are', () => {
  const sections = customizeSections(report());
  expect(section(sections, 'environment').rows).toEqual([
    { id: 'lock', label: 'Lock file', value: 'uv.lock present', state: 'ok' },
    {
      id: 'venv',
      label: 'Virtual environment',
      value: 'No .venv',
      state: 'warn'
    }
  ]);
  expect(section(sections, 'tools').rows).toEqual([
    {
      id: 'uv',
      label: 'uv',
      value: 'Found · 0.8.0',
      detail: '/usr/bin/uv',
      state: 'ok'
    },
    {
      id: 'git',
      label: 'git',
      value: 'Found · 2.51.0',
      detail: '/usr/bin/git',
      state: 'ok'
    },
    {
      id: 'git-annex',
      label: 'git-annex',
      value: 'Found · 10.20250901',
      detail: '/usr/bin/git-annex',
      state: 'ok'
    },
    {
      id: 'myst',
      label: 'myst',
      value: 'Not found',
      detail: undefined,
      state: 'missing'
    }
  ]);
  expect(section(sections, 'boundary').rows).toEqual([
    { id: 'sandbox', label: 'Sandbox', value: 'landlock', state: 'ok' }
  ]);
  expect(section(sections, 'storage').rows).toEqual([
    { id: 'annex', label: 'git-annex', value: 'Initialized', state: 'ok' },
    { id: 'remotes', label: 'Remotes', value: 'origin', state: 'ok' }
  ]);
});

it('degrades the boundary and storage rows without hiding them', () => {
  const unavailable = customizeSections(
    report({
      sandbox: { backend: 'seatbelt', available: false },
      storage: { annex: false, remotes: [] }
    })
  );
  expect(section(unavailable, 'boundary').rows[0]).toMatchObject({
    value: 'seatbelt (not available)',
    state: 'warn'
  });
  expect(section(unavailable, 'storage').rows).toEqual([
    {
      id: 'annex',
      label: 'git-annex',
      value: 'Not initialized',
      state: 'warn'
    },
    { id: 'remotes', label: 'Remotes', value: 'None', state: 'neutral' }
  ]);
  const none = customizeSections(
    report({
      sandbox: { backend: null, available: false },
      environment: null,
      storage: null
    })
  );
  expect(section(none, 'boundary').rows[0]).toMatchObject({
    value: 'None detected',
    state: 'warn'
  });
  expect(section(none, 'environment').rows).toEqual([]);
  expect(section(none, 'storage').rows).toEqual([]);
});

it('counts the rows that need attention and phrases the total', () => {
  const sections = customizeSections(report());
  // Codex executable, Codex skill, missing .venv and myst.
  expect(attentionCount(sections)).toBe(4);
  expect(attentionSummary(4)).toBe('4 items need attention.');
  expect(attentionSummary(1)).toBe('1 item needs attention.');
  expect(attentionSummary(0)).toBe('Everything Lightcone needs is in place.');
  const complete = report({
    agents: [report().agents[0]],
    skills: [report().skills[0]],
    tools: { ...report().tools, myst: tool(true, '1.6.0', '/usr/bin/myst') },
    environment: { lock: true, venv: true }
  });
  expect(attentionCount(customizeSections(complete))).toBe(0);
});

it('groups themes by light and dark, sorted by display name', () => {
  const displayNames: Record<string, string> = {
    'JupyterLab Light': 'JupyterLab Light',
    'JupyterLab Dark': 'JupyterLab Dark',
    'Lightcone Dark': 'Lightcone Dark',
    'Lightcone Light': 'Lightcone Light',
    'zz-plugin:theme': 'Aardvark'
  };
  const light = new Set([
    'JupyterLab Light',
    'Lightcone Light',
    'zz-plugin:theme'
  ]);
  expect(
    themeChoices({
      themes: Object.keys(displayNames),
      getDisplayName: name => displayNames[name],
      isLight: name => light.has(name)
    })
  ).toEqual({
    light: [
      { name: 'zz-plugin:theme', displayName: 'Aardvark' },
      { name: 'JupyterLab Light', displayName: 'JupyterLab Light' },
      { name: 'Lightcone Light', displayName: 'Lightcone Light' }
    ],
    dark: [
      { name: 'JupyterLab Dark', displayName: 'JupyterLab Dark' },
      { name: 'Lightcone Dark', displayName: 'Lightcone Dark' }
    ]
  });
});
