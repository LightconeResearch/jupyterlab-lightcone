import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { MessageLoop } from '@lumino/messaging';
import { Menu, Widget } from '@lumino/widgets';
import { requestAPI } from '../../request';
import { ComputeModel } from '../compute-model';
import { ComputeView, SETTINGS_EDITOR_COMMAND } from '../compute-section';
import { hostTarget, listing, slurmTarget } from './compute-fixtures';

jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => {
  const actual = jest.requireActual('@jupyterlab/apputils');
  return {
    ...actual,
    showDialog: jest.fn(),
    showErrorMessage: jest.fn().mockResolvedValue(undefined)
  };
});
const request = jest.mocked(requestAPI);
const dialog = jest.mocked(showDialog);

const BASE = 'jp-jupyterlab-lightcone-Compute';
const REGULAR = {
  label: 'Regular · 4 nodes · 2 h',
  backend: 'slurm' as const,
  nodes: 4,
  time: '2:00:00'
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function view(
  targets = [hostTarget({ variant: 'login', state: 'check-only' })]
) {
  request.mockImplementation(async (endpoint: string) =>
    endpoint.startsWith('api/compute/clusters')
      ? slurmTarget()
      : listing(targets)
  );
  const commands = new CommandRegistry();
  const settingsOpened: unknown[] = [];
  commands.addCommand(SETTINGS_EDITOR_COMMAND, {
    execute: args => void settingsOpened.push(args)
  });
  const model = new ComputeModel({
    serverSettings: ServerConnection.makeSettings()
  });
  model.presets = [
    REGULAR,
    { label: 'Medium', backend: 'gateway', workers: 6 }
  ];
  await model.refresh();
  const widget = new ComputeView({ model, commands });
  Widget.attach(widget, document.body);
  widget.update();
  MessageLoop.flush();
  await widget.renderPromise;
  return { widget, model, settingsOpened };
}

/** The menu the view opened last. */
let opened: Menu[] = [];
beforeEach(() => {
  opened = [];
  const open = Menu.prototype.open;
  jest.spyOn(Menu.prototype, 'open').mockImplementation(function (
    this: Menu,
    x,
    y,
    options
  ) {
    opened.push(this);
    open.call(this, x, y, options);
  });
});

function lastMenu(): Menu {
  const menu = opened[opened.length - 1];
  if (!menu) {
    throw new Error('No menu was opened');
  }
  return menu;
}

function menuLabels(): string[] {
  const menu = lastMenu();
  return menu.items
    .filter(item => item.type !== 'separator')
    .map(item => item.label);
}

function clickMenuItem(label: string) {
  const menu = lastMenu();
  const index = menu.items.findIndex(item => item.label === label);
  if (index < 0) {
    throw new Error(`No menu item ${label}`);
  }
  menu.activeIndex = index;
  menu.triggerActiveItem();
}

afterEach(async () => {
  jest.restoreAllMocks();
  document.body.innerHTML = '';
  request.mockReset();
  dialog.mockReset();
  await flush();
});

test('New cluster offers the presets this server can start, then a custom size and the settings', async () => {
  const { widget, settingsOpened } = await view();
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-new`)?.click();
  expect(menuLabels()).toEqual([
    'Regular · 4 nodes · 2 h · ≈ 8 node-hours',
    'Custom…',
    'Edit presets…'
  ]);
  clickMenuItem('Edit presets…');
  await flush();
  expect(settingsOpened).toEqual([{ query: 'Lightcone Compute' }]);
  widget.dispose();
});

test('choosing a preset starts it for the current project', async () => {
  const { widget } = await view();
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-new`)?.click();
  clickMenuItem('Regular · 4 nodes · 2 h · ≈ 8 node-hours');
  await flush();
  await flush();
  const post = request.mock.calls.find(
    ([endpoint]) => endpoint === 'api/compute/clusters'
  );
  expect(JSON.parse(String(post?.[2]?.body))).toEqual({
    preset: REGULAR,
    path: null
  });
  widget.dispose();
});

test('a cluster menu states its facts, opens its dashboard and stops it after asking', async () => {
  const cluster = slurmTarget();
  const { widget } = await view([hostTarget({ active: false }), cluster]);
  const open = jest.spyOn(window, 'open').mockReturnValue(null);
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-more`)?.click();
  expect(menuLabels()).toEqual([
    'Regular · 4 nodes · 2 h · Job 31415926 · regular · m1234',
    'Open dashboard',
    'Stop…'
  ]);
  clickMenuItem('Open dashboard');
  expect(open).toHaveBeenCalledWith(cluster.dashboard, '_blank', 'noopener');

  dialog.mockResolvedValue({
    button: Dialog.warnButton(),
    value: null,
    isChecked: null
  } as never);
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-more`)?.click();
  clickMenuItem('Stop…');
  await flush();
  await flush();
  expect(dialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Stop the slurm cluster?' })
  );
  expect(request).toHaveBeenCalledWith(
    `api/compute/clusters/${cluster.id}`,
    expect.anything(),
    { method: 'DELETE' }
  );
  open.mockRestore();
  widget.dispose();
});

test('a cancelled stop leaves the cluster alone', async () => {
  const { widget } = await view([hostTarget({ active: false }), slurmTarget()]);
  dialog.mockResolvedValue({
    button: Dialog.cancelButton(),
    value: null,
    isChecked: null
  } as never);
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-more`)?.click();
  clickMenuItem('Stop…');
  await flush();
  expect(
    request.mock.calls.some(([, , init]) => init?.method === 'DELETE')
  ).toBe(false);
  widget.dispose();
});

test.each([false, true])(
  'replacing asks before stopping and restarting (accepted: %s)',
  async accept => {
    const cluster = slurmTarget({
      problem: { code: 'version', message: 'Workers need an update.' }
    });
    const { widget } = await view([hostTarget({ active: false }), cluster]);
    dialog.mockResolvedValue({
      button: accept ? Dialog.warnButton() : Dialog.cancelButton(),
      value: null,
      isChecked: null
    } as never);
    widget.node.querySelector<HTMLButtonElement>(`.${BASE}-fix`)?.click();
    await flush();
    await flush();
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Runs using it, in every project, stop too. Outputs they already made are kept.'
      })
    );
    const mutations = request.mock.calls.filter(([, , init]) => init?.method);
    expect(mutations.map(([, , init]) => init?.method)).toEqual(
      accept ? ['DELETE', 'POST'] : []
    );
    widget.dispose();
  }
);

test('a failed stop prevents replacement', async () => {
  const cluster = slurmTarget({
    problem: { code: 'version', message: 'Workers need an update.' }
  });
  const { widget, model } = await view([
    hostTarget({ active: false }),
    cluster
  ]);
  const start = jest.spyOn(model, 'start');
  jest.spyOn(model, 'stop').mockRejectedValue(new Error('Still running'));
  dialog.mockResolvedValue({
    button: Dialog.warnButton(),
    value: null,
    isChecked: null
  } as never);
  widget.node.querySelector<HTMLButtonElement>(`.${BASE}-fix`)?.click();
  await flush();
  expect(start).not.toHaveBeenCalled();
  widget.dispose();
});

test('replacement is unavailable for an ambiguous preset label', async () => {
  const cluster = slurmTarget({
    problem: { code: 'version', message: 'Workers need an update.' }
  });
  const { widget, model } = await view([
    hostTarget({ active: false }),
    cluster
  ]);
  model.presets = [REGULAR, { ...REGULAR, nodes: 8 }];
  MessageLoop.flush();
  await widget.renderPromise;
  expect(widget.node.querySelector(`.${BASE}-fix`)).toBeNull();
  widget.dispose();
});
