import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../commands';
import type { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import {
  buildTourSteps,
  isTourHandler,
  registerTour,
  tourPlugin,
  TOUR_ID,
  TOUR_VERSION,
  type ITourStep
} from '../tour';

jest.mock('../pdf-runtime', () => ({}));

const trans = nullTranslator.load('jupyterlab_lightcone');
const settings = ServerConnection.makeSettings();
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const CARDS: Record<string, [label: string, caption: string]> = {
  [CommandIDs.createProject]: ['Create project', ''],
  [CommandIDs.openExistingProject]: ['Open project', ''],
  [CommandIDs.discuss]: [
    'Lightcone Agent',
    'Open Lightcone Agent for this ASTRA project'
  ],
  [CommandIDs.openInventory]: [
    'ASTRA Inventory',
    'Open the project inventory in Lightcone Lab'
  ],
  [CommandIDs.openMySTRA]: [
    'MySTRA Viewer',
    'Open this project with its ASTRA publication theme'
  ]
};

class FakeCurrent implements ICurrentProject {
  project: IProjectRoot | null | undefined = null;
  readonly changed: Signal<ICurrentProject, void> = new Signal(this);
}

/** The commands jupyterlab-tour and the launcher provide, recording what the tour asks of them. */
function host(cards: string[] = Object.keys(CARDS)) {
  const commands = new CommandRegistry();
  for (const command of cards) {
    const [label, caption] = CARDS[command];
    commands.addCommand(command, { label, caption, execute: () => undefined });
  }
  const handler = {
    steps: [] as ITourStep[],
    running: false,
    isRunning() {
      return this.running;
    },
    stepChanged: new Signal<unknown, { type: string }>({})
  };
  const added: ReadonlyPartialJSONObject[] = [];
  const launched: ReadonlyPartialJSONObject[] = [];
  commands.addCommand('jupyterlab-tour:add', {
    execute: args => {
      added.push(args.tour as ReadonlyPartialJSONObject);
      return handler;
    }
  });
  commands.addCommand('jupyterlab-tour:launch', {
    execute: args => {
      launched.push(args);
    }
  });
  const created = jest.fn();
  commands.addCommand('launcher:create', { execute: created });
  const main: Widget[] = [];
  const shell = { activateById: jest.fn(), widgets: () => main.values() };
  const current = new FakeCurrent();
  const app = { commands, shell, serviceManager: { serverSettings: settings } };
  return {
    app,
    commands,
    handler,
    added,
    launched,
    created,
    main,
    shell,
    current
  };
}

it('stays out of the way without jupyterlab-tour', async () => {
  const { app, commands } = host();
  const bare = { ...app, commands: new CommandRegistry() };
  expect(await registerTour(bare, null, trans)).toBeNull();
  expect(commands.hasCommand(CommandIDs.tour)).toBe(false);
});

it('registers the tour and keeps its steps in line with the current project', async () => {
  const h = host();
  expect(await registerTour(h.app, h.current, trans)).toBe(h.handler);
  expect(h.added).toEqual([
    {
      id: TOUR_ID,
      label: 'Lightcone Lab Tour',
      hasHelpEntry: true,
      icon: 'jupyterlab-lightcone:astra',
      version: TOUR_VERSION,
      steps: []
    }
  ]);
  const titles = () => h.handler.steps.map(step => step.title);
  expect(titles()).toEqual([
    'Welcome to Lightcone Lab',
    'Create project',
    'Open project',
    'Inside a project',
    'Coding agents on this server',
    'Choosing the agent'
  ]);
  expect(h.handler.steps[1].target).toBe(
    '.jp-MainAreaWidget:not(.lm-mod-hidden) .jp-Launcher .jp-LauncherCard[data-category^="Lightcone Lab"][title="Create project"]'
  );
  expect(h.handler.steps[0].placement).toBe('center');
  expect(h.handler.steps[4].styles).toEqual({ options: { width: 560 } });
  h.current.project = { path: 'project', entrypoint: 'project/astra.yaml' };
  h.current.changed.emit();
  expect(titles()).toEqual([
    'Welcome to Lightcone Lab',
    'Lightcone Agent',
    'ASTRA Inventory',
    'MySTRA Viewer',
    'Outside a project',
    'Coding agents on this server',
    'Choosing the agent'
  ]);
  // A card is found by the caption JupyterLab uses as the card's title.
  expect(h.handler.steps[1].target).toContain(
    '[title="Open Lightcone Agent for this ASTRA project"]'
  );
  // A running tour keeps its steps until the next launch.
  h.handler.running = true;
  h.current.project = null;
  h.current.changed.emit();
  expect(titles()[1]).toBe('Lightcone Agent');
});

it('only describes cards whose commands exist', () => {
  const { commands } = host([CommandIDs.openInventory, CommandIDs.openMySTRA]);
  const steps = buildTourSteps({
    trans,
    commands,
    settings,
    project: { path: 'project', entrypoint: 'project/astra.yaml' }
  });
  expect(steps.map(step => step.title)).toEqual([
    'Welcome to Lightcone Lab',
    'ASTRA Inventory',
    'MySTRA Viewer',
    'Outside a project',
    'Coding agents on this server',
    'Choosing the agent'
  ]);
});

it('offers the tour once at startup and again on demand', async () => {
  const h = host();
  const palette = { addItem: jest.fn() };
  tourPlugin.activate(
    { ...h.app, restored: Promise.resolve() } as unknown as JupyterFrontEnd,
    h.current,
    palette,
    null
  );
  await flush();
  await flush();
  expect(h.launched).toEqual([{ id: TOUR_ID, force: false }]);
  expect(palette.addItem).toHaveBeenCalledWith({
    command: CommandIDs.tour,
    category: 'Lightcone Lab'
  });
  expect(h.commands.label(CommandIDs.tour)).toBe('Lightcone Lab Tour');
  await h.commands.execute(CommandIDs.tour);
  expect(h.launched[1]).toEqual({ id: TOUR_ID, force: true });
});

it('brings a launcher forward when the tour starts', async () => {
  const h = host();
  await registerTour(h.app, h.current, trans);
  h.handler.stepChanged.emit({ type: 'step:after' });
  expect(h.created).not.toHaveBeenCalled();
  h.handler.stepChanged.emit({ type: 'tour:start' });
  expect(h.created).toHaveBeenCalledTimes(1);
  // An open launcher in another tab is shown rather than duplicated.
  const launcher = new MainAreaWidget({ content: new Widget() });
  launcher.content.addClass('jp-Launcher');
  h.main.push(launcher);
  h.handler.stepChanged.emit({ type: 'tour:start' });
  expect(h.shell.activateById).toHaveBeenCalledWith(launcher.id);
  expect(h.created).toHaveBeenCalledTimes(1);
  // A visible launcher needs nothing.
  const visible = document.createElement('div');
  visible.className = 'jp-MainAreaWidget';
  visible.innerHTML = '<div class="jp-Launcher"></div>';
  document.body.appendChild(visible);
  h.handler.stepChanged.emit({ type: 'tour:start' });
  expect(h.shell.activateById).toHaveBeenCalledTimes(1);
  visible.remove();
});

it('recognizes only a handler with steps, a running state and a step signal', () => {
  expect(isTourHandler(null)).toBe(false);
  expect(isTourHandler({ steps: [], isRunning: () => false })).toBe(false);
  expect(
    isTourHandler({
      steps: [],
      isRunning: () => false,
      stepChanged: new Signal({})
    })
  ).toBe(true);
});
