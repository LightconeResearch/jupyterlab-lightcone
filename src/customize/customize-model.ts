import type { IThemeManager } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type {
  IAgentSetup,
  ISetupReport,
  ISkillSetup,
  ITool
} from './setup-api';

/** How a row reads at a glance; the row's text always says the same thing. */
export type CustomizeRowState = 'ok' | 'warn' | 'missing' | 'neutral';

/** An action a row offers; the page performs it through JupyterLab commands. */
export interface ICustomizeAction {
  kind: 'open-file';
  label: string;
  /** Contents path of the file to open. */
  path: string;
}

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

function agentRow(agent: IAgentSetup): ICustomizeRow {
  const { executable } = agent;
  if (agent.installed && executable.found) {
    return {
      id: agent.id,
      label: agent.name,
      value: 'Ready',
      detail: executable.path ?? executable.name,
      state: 'ok'
    };
  }
  if (!agent.installed) {
    return {
      id: agent.id,
      label: agent.name,
      value: 'Jupyter AI ACP client not installed',
      detail: executable.found
        ? `${executable.name}: ${executable.path ?? 'found'}`
        : `${executable.name}: not found`,
      state: 'missing'
    };
  }
  return {
    id: agent.id,
    label: agent.name,
    value: `${executable.name} not found on the server's PATH`,
    state: 'missing'
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

function environmentSection(report: ISetupReport): ICustomizeSection {
  const environment = report.environment;
  return {
    id: 'environment',
    title: 'Environment',
    summary: 'The Python environment the recipes run in.',
    rows: environment
      ? [
          {
            id: 'lock',
            label: 'Lock file',
            value: environment.lock ? 'uv.lock present' : 'No uv.lock',
            state: environment.lock ? 'ok' : 'warn'
          },
          {
            id: 'venv',
            label: 'Virtual environment',
            value: environment.venv ? '.venv present' : 'No .venv',
            state: environment.venv ? 'ok' : 'warn'
          }
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

function boundarySection(report: ISetupReport): ICustomizeSection {
  const { backend, available } = report.sandbox;
  return {
    id: 'boundary',
    title: 'Execution boundary',
    summary:
      'The sandbox around lc run and lc materialize. It does not confine an agent’s own shell.',
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
      }
    ],
    empty: 'The sandbox was not checked.'
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
          }
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
