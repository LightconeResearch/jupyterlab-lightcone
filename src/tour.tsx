import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, MainAreaWidget } from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import type { ISignal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import React from 'react';
import { AgentReadiness } from './agent-readiness';
import { isRecord } from './api';
import { CommandIDs } from './commands';
import { ICurrentProject } from './current-project';
import { astraIcon } from './icons';
import type { IProjectRoot } from './project-root';

/** The tour's identity in jupyterlab-tour, which records per user whether it was taken. */
export const TOUR_ID = 'jupyterlab_lightcone:tour';
/** Calendar version; raise it when returning users should be offered the tour again. */
export const TOUR_VERSION = 20260922;
const CATEGORY = 'Lightcone Lab';
/** jupyterlab-tour is driven through its public commands only, so it stays optional. */
const TOUR_ADD = 'jupyterlab-tour:add';
const TOUR_LAUNCH = 'jupyterlab-tour:launch';
const LAUNCHER_CREATE = 'launcher:create';
const LAUNCHER_CLASS = 'jp-Launcher';
/** A launcher the user can see: the dock hides inactive tabs with Lumino's hidden class. */
const VISIBLE_LAUNCHER = `.jp-MainAreaWidget:not(.lm-mod-hidden) .${LAUNCHER_CLASS}`;
const CENTER = '#jp-main-dock-panel';

/** The part of a react-joyride step this tour uses. */
export interface ITourStep {
  target: string;
  title: string;
  content: React.ReactNode;
  placement: 'center' | 'bottom';
  disableBeacon: boolean;
  styles?: { options: { width: number } };
}

/** A progress report from jupyterlab-tour, which relays react-joyride's callback data. */
export interface ITourEvent {
  type: string;
}

/** The part of jupyterlab-tour's tour handler this extension relies on. */
export interface ITourHandler {
  steps: ITourStep[];
  isRunning(): boolean;
  readonly stepChanged: ISignal<unknown, ITourEvent>;
}

/** What the tour needs from the application. */
export interface ITourHost {
  commands: CommandRegistry;
  shell: {
    activateById(id: string): void;
    widgets(area?: string): IterableIterator<Widget>;
  };
  serviceManager: { serverSettings: ServerConnection.ISettings };
}

export interface ITourContext {
  trans: TranslationBundle;
  commands: CommandRegistry;
  settings: ServerConnection.ISettings;
  project: IProjectRoot | null | undefined;
}

/** Recognize the handler jupyterlab-tour returns from its add command. */
export function isTourHandler(value: unknown): value is ITourHandler {
  return (
    isRecord(value) &&
    Array.isArray(value.steps) &&
    typeof value.isRunning === 'function' &&
    isRecord(value.stepChanged) &&
    typeof value.stepChanged.connect === 'function'
  );
}

/**
 * The launcher card of a command, as JupyterLab renders it: the card's title
 * is the command's caption, or its label when there is none. Looking the text
 * up here keeps the selector right in every language.
 */
function launcherCard(commands: CommandRegistry, command: string): string {
  const title = commands.caption(command) || commands.label(command);
  const escaped = title.replace(/["\\]/g, '\\$&');
  return `${VISIBLE_LAUNCHER} .jp-LauncherCard[data-category^="${CATEGORY}"][title="${escaped}"]`;
}

/**
 * The steps for the current project state. Cards only exist for commands the
 * application has, and a card missing when a step is reached is skipped by the
 * tour, so a closed launcher costs the user a step rather than the tour.
 */
export function buildTourSteps(context: ITourContext): ITourStep[] {
  const { trans, commands, project } = context;
  const center = (title: string, content: React.ReactNode): ITourStep => ({
    target: CENTER,
    title,
    content,
    placement: 'center',
    disableBeacon: true
  });
  const card = (
    command: string,
    title: string,
    content: React.ReactNode
  ): ITourStep[] =>
    commands.hasCommand(command)
      ? [
          {
            target: launcherCard(commands, command),
            title,
            content,
            placement: 'bottom',
            disableBeacon: true
          }
        ]
      : [];
  const steps: ITourStep[] = [
    center(
      trans.__('Welcome to Lightcone Lab'),
      <>
        <p>
          {trans.__(
            'Lightcone Lab turns JupyterLab into a research workbench around ASTRA projects: an analysis specification, its inputs and results, and the decisions behind them.'
          )}
        </p>
        <p>
          {trans.__(
            'This tour explains the Lightcone Lab launcher cards and how to connect a coding agent.'
          )}
        </p>
        <p>
          <small>
            {trans.__(
              'Click outside a step to pause. Restart the tour any time from Help › Lightcone Lab Tour.'
            )}
          </small>
        </p>
      </>
    )
  ];
  if (project) {
    steps.push(
      ...card(
        CommandIDs.discuss,
        trans.__('Lightcone Agent'),
        <p>
          {trans.__(
            'Opens a Jupyter AI chat in the left sidebar for this project. The agent starts in the project folder, so lc, astra and relative paths work as they do in a terminal. Nothing is sent until you write a message.'
          )}
        </p>
      ),
      ...card(
        CommandIDs.openInventory,
        trans.__('ASTRA Inventory'),
        <p>
          {trans.__(
            'A read-only view of the project: outputs, decisions, inputs, findings and bibliography, with previews of tables and figures. It starts no kernel and changes no files.'
          )}
        </p>
      ),
      ...card(
        CommandIDs.openMySTRA,
        trans.__('MySTRA Viewer'),
        <p>
          {trans.__(
            'Renders the project as a publication with its ASTRA theme, served through this Jupyter server.'
          )}
        </p>
      ),
      center(
        trans.__('Outside a project'),
        <p>
          {trans.__(
            'When the file browser leaves the project, this section offers Create project and Open project instead. Both are also in the command palette under Lightcone Lab.'
          )}
        </p>
      )
    );
  } else {
    steps.push(
      ...card(
        CommandIDs.createProject,
        trans.__('Create project'),
        <p>
          {trans.__(
            'Starts a new ASTRA project: choose a folder, and Lightcone initializes it as lc init would. The server needs uv and git on its PATH.'
          )}
        </p>
      ),
      ...card(
        CommandIDs.openExistingProject,
        trans.__('Open project'),
        <p>
          {trans.__(
            'Browse to a folder that already holds an astra.yaml. The file browser moves there, the project becomes current, and this section switches to the project cards.'
          )}
        </p>
      ),
      center(
        trans.__('Inside a project'),
        <>
          <p>{trans.__('With a project open, this section offers:')}</p>
          <ul>
            <li>
              <strong>{trans.__('Lightcone Agent')}</strong>
              {trans.__(
                ': a Jupyter AI chat whose agent works in the project folder.'
              )}
            </li>
            <li>
              <strong>{trans.__('ASTRA Inventory')}</strong>
              {trans.__(
                ': a read-only view of outputs, decisions, inputs, findings and bibliography.'
              )}
            </li>
            <li>
              <strong>{trans.__('MySTRA Viewer')}</strong>
              {trans.__(
                ': the project rendered as a publication with its ASTRA theme.'
              )}
            </li>
          </ul>
        </>
      )
    );
  }
  steps.push(
    {
      ...center(
        trans.__('Coding agents on this server'),
        <>
          <p>
            {trans.__(
              'Lightcone Agent chats through Jupyter AI, which runs coding agents such as Claude Code, Codex and OpenCode over the Agent Client Protocol (ACP). Each agent needs its adapter installed where this Jupyter server runs; Jupyter AI hides agents whose adapter is missing.'
            )}
          </p>
          <AgentReadiness settings={context.settings} trans={trans} />
        </>
      ),
      styles: { options: { width: 560 } }
    },
    center(
      trans.__('Choosing the agent'),
      <>
        <p>
          {trans.__(
            'Open Lightcone Agent, then pick Claude, Codex or OpenCode in the persona menu beside the chat composer. Your first message may ask you to sign in; do that with the agent’s own command in a terminal on the server.'
          )}
        </p>
        <p>
          <small>
            {trans.__(
              'That is the tour. Restart it from Help › Lightcone Lab Tour or the command palette.'
            )}
          </small>
        </p>
      </>
    )
  );
  return steps;
}

/** Bring a launcher forward for the card steps, reusing an open one before creating another. */
function showLauncher(app: ITourHost): void {
  if (document.querySelector(VISIBLE_LAUNCHER)) return;
  for (const widget of app.shell.widgets('main')) {
    if (
      widget instanceof MainAreaWidget &&
      widget.content.hasClass(LAUNCHER_CLASS)
    ) {
      app.shell.activateById(widget.id);
      return;
    }
  }
  if (app.commands.hasCommand(LAUNCHER_CREATE)) {
    void app.commands.execute(LAUNCHER_CREATE).catch(error => {
      console.warn('Could not open a launcher for the tour.', error);
    });
  }
}

/**
 * Register the tour with jupyterlab-tour and keep its steps in line with the
 * current project. Resolves to null when jupyterlab-tour is not installed or
 * refuses the tour.
 */
export async function registerTour(
  app: ITourHost,
  current: ICurrentProject | null,
  trans: TranslationBundle
): Promise<ITourHandler | null> {
  const { commands } = app;
  if (!commands.hasCommand(TOUR_ADD) || !commands.hasCommand(TOUR_LAUNCH)) {
    return null;
  }
  const handler: unknown = await commands.execute(TOUR_ADD, {
    tour: {
      id: TOUR_ID,
      label: trans.__('Lightcone Lab Tour'),
      hasHelpEntry: true,
      icon: astraIcon.name,
      version: TOUR_VERSION,
      steps: []
    }
  });
  if (!isTourHandler(handler)) return null;
  const settings = app.serviceManager.serverSettings;
  const refresh = () => {
    // A running tour keeps its steps; the next launch reflects the project.
    if (handler.isRunning()) return;
    handler.steps = buildTourSteps({
      trans,
      commands,
      settings,
      project: current?.project ?? null
    });
  };
  refresh();
  current?.changed.connect(refresh);
  handler.stepChanged.connect((_sender, event) => {
    if (event.type === 'tour:start') showLauncher(app);
  });
  return handler;
}

/** A tour of the launcher cards and of coding-agent setup, offered once per user. */
export const tourPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:tour',
  description:
    'A tour of the Lightcone Lab launcher and of coding-agent setup, through jupyterlab-tour.',
  autoStart: true,
  optional: [ICurrentProject, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    // jupyterlab-tour adds its commands while starting; every plugin has by
    // the time the layout is restored, and so has the launcher the cards need.
    void app.restored
      .then(async () => {
        const handler = await registerTour(app, current, trans);
        if (!handler) return;
        app.commands.addCommand(CommandIDs.tour, {
          label: trans.__('Lightcone Lab Tour'),
          caption: trans.__(
            'Tour the Lightcone Lab launcher and set up a coding agent'
          ),
          icon: astraIcon,
          describedBy: { args: { type: 'object', properties: {} } },
          execute: () =>
            app.commands.execute(TOUR_LAUNCH, { id: TOUR_ID, force: true })
        });
        palette?.addItem({ command: CommandIDs.tour, category: CATEGORY });
        // Offered once: jupyterlab-tour remembers per user when it was taken or declined.
        await app.commands.execute(TOUR_LAUNCH, { id: TOUR_ID, force: false });
      })
      .catch(error => {
        console.warn('Could not register the Lightcone Lab tour.', error);
      });
  }
};
