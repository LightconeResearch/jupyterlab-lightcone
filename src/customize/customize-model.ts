import type { IThemeManager } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type {
  IAgentSetup,
  IContainerSetup,
  IEnvironmentSetup,
  IKernelSetup,
  ISetupReport,
  ISkillSetup,
  IStorageSetup,
  ITool
} from './setup-api';

/** How a row reads at a glance; the row's text always says the same thing. */
export type CustomizeRowState = 'ok' | 'warn' | 'missing' | 'neutral';

/** An action a row offers; the page performs it. */
export type ICustomizeAction =
  | {
      kind: 'open-file';
      label: string;
      /** Contents path of the file to open. */
      path: string;
    }
  | {
      kind: 'register-kernel';
      label: string;
    };

/** One line of real state on the settings page. */
export interface ICustomizeRow {
  /** Stable within its section. */
  id: string;
  label: string;
  value: string;
  /** A path or other secondary detail, shown in a monospace face. */
  detail?: string;
  state: CustomizeRowState;
  action?: ICustomizeAction;
}

export type CustomizeSectionId =
  | 'agents'
  | 'skills'
  | 'instructions'
  | 'environment'
  | 'tools'
  | 'boundary'
  | 'storage';

/** A section of the settings page, in display order. */
export interface ICustomizeSection {
  id: CustomizeSectionId;
  title: string;
  /** One line under the title saying what the section reflects. */
  summary: string;
  rows: ICustomizeRow[];
  /** Shown in place of the rows when there are none. */
  empty: string;
}

const HARNESS_LABELS: Record<ISkillSetup['harness'], string> = {
  claude: 'Claude Code',
  codex: 'Codex'
};

/** One fact about an agent, as the row lists it. */
export interface IAgentFact {
  text: string;
  state: CustomizeRowState;
}

/**
 * What the page knows about an agent, each fact on its own: installed (the
 * ACP client and the adapter), discovered by Jupyter AI, and signed in.
 */
export function agentFacts(agent: IAgentSetup): IAgentFact[] {
  const { executable } = agent;
  return [
    agent.installed
      ? { text: 'ACP client installed', state: 'ok' }
      : { text: 'Jupyter AI ACP client not installed', state: 'missing' },
    executable.found
      ? { text: `${executable.name} found`, state: 'ok' }
      : {
          text: `${executable.name} not found on the server's PATH`,
          state: 'missing'
        },
    agent.discovered === null
      ? {
          text: 'not loaded by Jupyter AI yet (open a session)',
          state: 'neutral'
        }
      : agent.discovered
        ? { text: 'discovered by Jupyter AI', state: 'ok' }
        : {
            text: 'not discovered by Jupyter AI (restart the server after installing)',
            state: 'missing'
          },
    agent.authenticated === null
      ? { text: 'sign-in unknown', state: 'neutral' }
      : agent.authenticated
        ? { text: 'signed in', state: 'ok' }
        : { text: 'no credentials found', state: 'warn' }
  ];
}

const STATE_SEVERITY: Record<CustomizeRowState, number> = {
  ok: 0,
  neutral: 1,
  warn: 2,
  missing: 3
};

/** The most severe state among some facts. */
function worst(states: readonly CustomizeRowState[]): CustomizeRowState {
  return states.reduce<CustomizeRowState>(
    (current, state) =>
      STATE_SEVERITY[state] > STATE_SEVERITY[current] ? state : current,
    'ok'
  );
}

function agentRow(agent: IAgentSetup): ICustomizeRow {
  const facts = agentFacts(agent);
  const state = worst(facts.map(fact => fact.state));
  return {
    id: agent.id,
    label: agent.name,
    value:
      state === 'ok'
        ? 'Ready'
        : (facts.find(fact => fact.state === state)?.text ?? 'Ready'),
    detail: [
      ...facts.map(fact => fact.text),
      ...(agent.executable.path ? [agent.executable.path] : [])
    ].join(' · '),
    state
  };
}

function skillRow(skill: ISkillSetup): ICustomizeRow {
  return {
    id: `${skill.harness}:${skill.name}`,
    label: skill.name,
    value: skill.found
      ? skill.version
        ? `Installed · ${skill.version}`
        : 'Installed'
      : 'Not found',
    detail: `${HARNESS_LABELS[skill.harness]} · ${skill.path}`,
    state: skill.found ? 'ok' : 'missing'
  };
}

function toolRow(id: string, tool: ITool): ICustomizeRow {
  return {
    id,
    label: id,
    value: tool.found
      ? tool.version
        ? `Found · ${tool.version}`
        : 'Found'
      : 'Not found',
    detail: tool.path ?? undefined,
    state: tool.found ? 'ok' : 'missing'
  };
}

function agentsSection(report: ISetupReport): ICustomizeSection {
  return {
    id: 'agents',
    title: 'Agents',
    summary: report.jupyterAi
      ? 'Agents that can drive a session through Jupyter AI.'
      : 'Jupyter AI is not installed, so sessions are unavailable.',
    rows: report.agents.map(agentRow),
    empty: 'No agent adapters are known to this server.'
  };
}

function skillsSection(report: ISetupReport): ICustomizeSection {
  return {
    id: 'skills',
    title: 'Skills',
    summary: 'Lightcone and ASTRA skills each agent harness can load.',
    rows: report.skills.map(skillRow),
    empty: 'No Lightcone skill is installed for Claude Code or Codex.'
  };
}

function instructionsSection(report: ISetupReport): ICustomizeSection {
  const instructions = report.instructions;
  return {
    id: 'instructions',
    title: 'Project instructions',
    summary: 'What agents read before working in this project.',
    rows: instructions
      ? [
          {
            id: 'instructions',
            label: PathExt.basename(instructions.path),
            value: instructions.exists ? 'Present' : 'Not found',
            detail: instructions.path,
            state: instructions.exists ? 'ok' : 'missing',
            ...(instructions.exists
              ? {
                  action: {
                    kind: 'open-file' as const,
                    label: 'Edit',
                    path: instructions.path
                  }
                }
              : {})
          }
        ]
      : [],
    empty: 'Open a Lightcone project to see its instructions.'
  };
}

function lockRow(environment: IEnvironmentSetup): ICustomizeRow {
  if (!environment.lock) {
    return {
      id: 'lock',
      label: 'Lock file',
      value: 'No uv.lock',
      state: 'warn'
    };
  }
  return {
    id: 'lock',
    label: 'Lock file',
    value:
      environment.lockCurrent === null
        ? 'uv.lock present'
        : environment.lockCurrent
          ? 'uv.lock matches pyproject.toml'
          : 'uv.lock is out of date with pyproject.toml',
    state: environment.lockCurrent === false ? 'warn' : 'ok'
  };
}

function venvRow(environment: IEnvironmentSetup): ICustomizeRow {
  if (environment.mode === 'containerized') {
    return {
      id: 'venv',
      label: 'Virtual environment',
      value: 'Recipes run in the project’s image, not in .venv',
      state: 'neutral'
    };
  }
  if (!environment.venv) {
    return {
      id: 'venv',
      label: 'Virtual environment',
      value: 'No .venv (lc materialize creates it)',
      state: 'warn'
    };
  }
  return {
    id: 'venv',
    label: 'Virtual environment',
    value:
      environment.venvCurrent === null
        ? '.venv present'
        : environment.venvCurrent
          ? '.venv matches uv.lock'
          : '.venv differs from uv.lock (lc materialize syncs it)',
    state: environment.venvCurrent === false ? 'warn' : 'ok'
  };
}

function kernelRow(kernel: IKernelSetup): ICustomizeRow {
  const register: ICustomizeAction = {
    kind: 'register-kernel',
    label: 'Register project kernel'
  };
  if (kernel.registered) {
    return {
      id: 'kernel',
      label: 'Notebook kernel',
      value: 'Registered: notebooks can run in the project environment',
      detail: kernel.name,
      state: 'ok'
    };
  }
  if (!kernel.python) {
    return {
      id: 'kernel',
      label: 'Notebook kernel',
      value: 'No project interpreter the server can run',
      state: 'neutral'
    };
  }
  if (kernel.ipykernel === false) {
    return {
      id: 'kernel',
      label: 'Notebook kernel',
      value:
        'ipykernel is not in the project environment: add it with uv add --dev ipykernel',
      detail: kernel.python,
      state: 'warn'
    };
  }
  return {
    id: 'kernel',
    label: 'Notebook kernel',
    value: 'Not registered',
    detail: kernel.python,
    state: 'neutral',
    action: register
  };
}

function environmentSection(report: ISetupReport): ICustomizeSection {
  const { environment, kernel } = report;
  return {
    id: 'environment',
    title: 'Environment',
    summary: 'The Python environment the recipes run in.',
    rows: environment
      ? [
          lockRow(environment),
          venvRow(environment),
          ...(kernel ? [kernelRow(kernel)] : [])
        ]
      : [],
    empty: 'Open a Lightcone project to see its environment.'
  };
}

function toolsSection(report: ISetupReport): ICustomizeSection {
  const { tools } = report;
  return {
    id: 'tools',
    title: 'Tools',
    summary: 'Command-line tools the server can reach.',
    rows: [
      toolRow('uv', tools.uv),
      toolRow('git', tools.git),
      toolRow('git-annex', tools['git-annex']),
      toolRow('myst', tools.myst)
    ],
    empty: 'No tools were checked.'
  };
}

const IMAGE_TEXT: Record<NonNullable<IContainerSetup['image']>, string> = {
  direct: 'not used: recipes run directly on this host',
  absent: 'image not built yet (lc build)',
  unfetched: 'image committed but its content is not here',
  present: 'image present'
};

function containerRow(box: IContainerSetup): ICustomizeRow {
  const image =
    box.image === null ? 'image state unknown' : IMAGE_TEXT[box.image];
  const needsRuntime = box.image !== null && box.image !== 'direct';
  return {
    id: 'container',
    label: 'Container',
    value: box.runtime ? `${box.runtime} · ${image}` : `No runtime · ${image}`,
    state:
      needsRuntime && (!box.runtime || box.image !== 'present')
        ? 'warn'
        : box.runtime || box.image === 'direct'
          ? 'ok'
          : 'neutral'
  };
}

function venueRow(report: ISetupReport): ICustomizeRow {
  const { slurm, nodes } = report.venue;
  return {
    id: 'venue',
    label: 'Compute',
    value: slurm
      ? nodes
        ? `SLURM allocation · ${nodes} ${nodes === 1 ? 'node' : 'nodes'}, one worker each`
        : 'SLURM allocation of unknown size'
      : 'This server’s host',
    state: 'neutral'
  };
}

function boundarySection(report: ISetupReport): ICustomizeSection {
  const { backend, available } = report.sandbox;
  return {
    id: 'boundary',
    title: 'Execution boundary',
    summary:
      'Where lc run and lc materialize execute recipes, and the sandbox around them. It does not confine an agent’s own shell.',
    rows: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        value:
          backend === null
            ? 'None detected'
            : available
              ? backend
              : `${backend} (not available)`,
        state: backend !== null && available ? 'ok' : 'warn'
      },
      ...(report.container ? [containerRow(report.container)] : []),
      venueRow(report)
    ],
    empty: 'The sandbox was not checked.'
  };
}

function contentRow(
  content: NonNullable<IStorageSetup['content']>
): ICustomizeRow {
  const { files, absent } = content;
  return {
    id: 'content',
    label: 'Result content',
    value: !files
      ? 'No annexed results yet'
      : absent
        ? `${absent} of ${files} annexed ${files === 1 ? 'result is' : 'results are'} not present here (git annex get)`
        : `All ${files} annexed ${files === 1 ? 'result is' : 'results are'} present here`,
    state: absent ? 'warn' : 'ok'
  };
}

function storageSection(report: ISetupReport): ICustomizeSection {
  const storage = report.storage;
  return {
    id: 'storage',
    title: 'Storage',
    summary: 'Where result versions are kept.',
    rows: storage
      ? [
          {
            id: 'annex',
            label: 'git-annex',
            value: storage.annex ? 'Initialized' : 'Not initialized',
            state: storage.annex ? 'ok' : 'warn'
          },
          {
            id: 'remotes',
            label: 'Remotes',
            value: storage.remotes.length ? storage.remotes.join(', ') : 'None',
            state: storage.remotes.length ? 'ok' : 'neutral'
          },
          ...(storage.content ? [contentRow(storage.content)] : [])
        ]
      : [],
    empty: 'Open a Lightcone project to see its storage.'
  };
}

/** Map a setup report to the sections the page shows, in display order. */
export function customizeSections(report: ISetupReport): ICustomizeSection[] {
  return [
    agentsSection(report),
    skillsSection(report),
    instructionsSection(report),
    environmentSection(report),
    toolsSection(report),
    boundarySection(report),
    storageSection(report)
  ];
}

/** How many rows are missing something or worth a look. */
export function attentionCount(sections: readonly ICustomizeSection[]): number {
  return sections.reduce(
    (count, section) =>
      count +
      section.rows.filter(
        row => row.state === 'missing' || row.state === 'warn'
      ).length,
    0
  );
}

/** One line for the top of the page. */
export function attentionSummary(count: number): string {
  if (count === 0) {
    return 'Everything Lightcone needs is in place.';
  }
  return count === 1
    ? '1 item needs attention.'
    : `${count} items need attention.`;
}

/** A theme the user can pick. */
export interface IThemeChoice {
  name: string;
  displayName: string;
}

/** Registered themes grouped for a picker, each group sorted by display name. */
export interface IThemeChoices {
  light: IThemeChoice[];
  dark: IThemeChoice[];
}

/** Group the theme manager's themes for the Appearance picker. */
export function themeChoices(
  manager: Pick<IThemeManager, 'themes' | 'getDisplayName' | 'isLight'>
): IThemeChoices {
  const choices = manager.themes
    .map(name => ({ name, displayName: manager.getDisplayName(name) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    light: choices.filter(choice => manager.isLight(choice.name)),
    dark: choices.filter(choice => !manager.isLight(choice.name))
  };
}
