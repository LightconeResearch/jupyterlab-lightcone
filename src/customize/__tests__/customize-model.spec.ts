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
        },
        discovered: true,
        authenticated: true
      },
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        executable: { name: 'codex-acp', found: false, path: null },
        discovered: false,
        authenticated: false
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
    venue: { slurm: false, nodes: null },
    environment: {
      lock: true,
      venv: false,
      mode: 'direct',
      lockCurrent: true,
      venvCurrent: null
    },
    kernel: {
      name: 'lightcone-project',
      python: null,
      ipykernel: null,
      registered: false
    },
    container: { runtime: null, image: 'direct' },
    instructions: { path: 'project/AGENTS.md', exists: true },
    storage: {
      annex: true,
      remotes: ['origin'],
      content: { files: 3, absent: 0 }
    },
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
      detail:
        'ACP client installed · claude-agent-acp found · discovered by Jupyter AI · signed in · /usr/bin/claude-agent-acp',
      state: 'ok'
    },
    {
      id: 'codex',
      label: 'Codex',
      value: "codex-acp not found on the server's PATH",
      detail:
        "ACP client installed · codex-acp not found on the server's PATH · not discovered by Jupyter AI (restart the server after installing) · no credentials found",
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
            },
            discovered: null,
            authenticated: null
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
    state: 'missing'
  });
  expect(uninstalled.rows[0].detail).toContain(
    'not loaded by Jupyter AI yet (open a session) · sign-in unknown'
  );
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
    {
      id: 'lock',
      label: 'Lock file',
      value: 'uv.lock matches pyproject.toml',
      state: 'ok'
    },
    {
      id: 'venv',
      label: 'Virtual environment',
      value: 'No .venv (lc materialize creates it)',
      state: 'warn'
    },
    {
      id: 'kernel',
      label: 'Notebook kernel',
      value: 'No project interpreter the server can run',
      state: 'neutral'
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
    { id: 'sandbox', label: 'Sandbox', value: 'landlock', state: 'ok' },
    {
      id: 'container',
      label: 'Container',
      value: 'No runtime · not used: recipes run directly on this host',
      state: 'ok'
    },
    {
      id: 'venue',
      label: 'Compute',
      value: 'This server’s host',
      state: 'neutral'
    }
  ]);
  expect(section(sections, 'storage').rows).toEqual([
    { id: 'annex', label: 'git-annex', value: 'Initialized', state: 'ok' },
    { id: 'remotes', label: 'Remotes', value: 'origin', state: 'ok' },
    {
      id: 'content',
      label: 'Result content',
      value: 'All 3 annexed results are present here',
      state: 'ok'
    }
  ]);
});

it('degrades the boundary and storage rows without hiding them', () => {
  const unavailable = customizeSections(
    report({
      sandbox: { backend: 'seatbelt', available: false },
      storage: { annex: false, remotes: [], content: null }
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
    environment: {
      lock: true,
      venv: true,
      mode: 'direct',
      lockCurrent: true,
      venvCurrent: true
    }
  });
  expect(attentionCount(customizeSections(complete))).toBe(0);
});

it('tells whether the lock and the environment are current', () => {
  const stale = customizeSections(
    report({
      environment: {
        lock: true,
        venv: true,
        mode: 'direct',
        lockCurrent: false,
        venvCurrent: false
      }
    })
  );
  expect(section(stale, 'environment').rows.slice(0, 2)).toEqual([
    {
      id: 'lock',
      label: 'Lock file',
      value: 'uv.lock is out of date with pyproject.toml',
      state: 'warn'
    },
    {
      id: 'venv',
      label: 'Virtual environment',
      value: '.venv differs from uv.lock (lc materialize syncs it)',
      state: 'warn'
    }
  ]);
  const boxed = customizeSections(
    report({
      environment: {
        lock: true,
        venv: false,
        mode: 'containerized',
        lockCurrent: null,
        venvCurrent: null
      },
      container: { runtime: 'podman', image: 'absent' }
    })
  );
  expect(section(boxed, 'environment').rows[1]).toMatchObject({
    value: 'Recipes run in the project’s image, not in .venv',
    state: 'neutral'
  });
  expect(section(boxed, 'boundary').rows[1]).toEqual({
    id: 'container',
    label: 'Container',
    value: 'podman · image not built yet (lc build)',
    state: 'warn'
  });
});

it('offers to register the project kernel only when it can run', () => {
  const kernelRow = (kernel: ISetupReport['kernel']) =>
    section(customizeSections(report({ kernel })), 'environment').rows[2];
  expect(
    kernelRow({
      name: 'lightcone-project',
      python: '/p/.venv/bin/python',
      ipykernel: true,
      registered: false
    })
  ).toEqual({
    id: 'kernel',
    label: 'Notebook kernel',
    value: 'Not registered',
    detail: '/p/.venv/bin/python',
    state: 'neutral',
    action: { kind: 'register-kernel', label: 'Register project kernel' }
  });
  expect(
    kernelRow({
      name: 'lightcone-project',
      python: '/p/.venv/bin/python',
      ipykernel: false,
      registered: false
    })
  ).not.toHaveProperty('action');
  expect(
    kernelRow({
      name: 'lightcone-project',
      python: '/p/.venv/bin/python',
      ipykernel: true,
      registered: true
    })
  ).toMatchObject({ state: 'ok', detail: 'lightcone-project' });
});

it('names a SLURM allocation and results whose content is elsewhere', () => {
  const sections = customizeSections(
    report({
      venue: { slurm: true, nodes: 4 },
      storage: {
        annex: true,
        remotes: ['origin'],
        content: { files: 3, absent: 1 }
      }
    })
  );
  expect(section(sections, 'boundary').rows[2].value).toBe(
    'SLURM allocation · 4 nodes, one worker each'
  );
  expect(section(sections, 'storage').rows[2]).toEqual({
    id: 'content',
    label: 'Result content',
    value: '1 of 3 annexed results are not present here (git annex get)',
    state: 'warn'
  });
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
