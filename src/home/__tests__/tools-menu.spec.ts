import { LauncherModel } from '@jupyterlab/launcher';
import { CommandRegistry } from '@lumino/commands';
import { HomeCommandIDs } from '../home-commands';
import { launcherCategory } from '../home-model';
import { buildToolsMenu } from '../tools-menu';

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  const add = (id: string, label: string) =>
    commands.addCommand(id, { label, execute: () => undefined });
  add('notebook:create-new', 'Python 3');
  add('terminal:create-new', 'Terminal');
  add('extras:open', 'Extras');
  add('jupyterlab_lightcone:open-inventory', 'ASTRA Inventory');
  add('jupyterlab_lightcone:new-project', 'New Lightcone project');
  add(HomeCommandIDs.showLauncher, 'Show the full launcher');
  commands.addCommand(HomeCommandIDs.toolsCategory, {
    label: args => String(args.category ?? ''),
    isEnabled: () => false,
    execute: () => undefined
  });
  return commands;
}

function model(): LauncherModel {
  const launcher = new LauncherModel();
  launcher.add({
    command: 'notebook:create-new',
    category: 'Notebook',
    args: { kernelName: 'python3' },
    kernelIconUrl: 'http://kernels/python3/logo.svg'
  });
  launcher.add({ command: 'terminal:create-new', category: 'Other' });
  // A third-party category that only starts like Lightcone's stays in Tools.
  launcher.add({ command: 'extras:open', category: 'Lightcone Labs Extras' });
  // Lightcone's own cards live in Home's body, not in Tools.
  launcher.add({
    command: 'jupyterlab_lightcone:open-inventory',
    category: launcherCategory('p')
  });
  launcher.add({
    command: 'jupyterlab_lightcone:new-project',
    category: launcherCategory(null)
  });
  return launcher;
}

describe('buildToolsMenu', () => {
  it('lists every other launcher item by category with the tab cwd, then the full launcher', () => {
    const menu = buildToolsMenu({
      model: model(),
      commands: registry(),
      cwd: 'work',
      widgetId: 'launcher-3'
    });
    try {
      expect(
        menu.items.map(item => [item.type, item.command, item.args])
      ).toEqual([
        ['command', HomeCommandIDs.toolsCategory, { category: 'Notebook' }],
        [
          'command',
          'notebook:create-new',
          { kernelName: 'python3', cwd: 'work' }
        ],
        ['command', HomeCommandIDs.toolsCategory, { category: 'Other' }],
        ['command', 'terminal:create-new', { cwd: 'work' }],
        [
          'command',
          HomeCommandIDs.toolsCategory,
          { category: 'Lightcone Labs Extras' }
        ],
        ['command', 'extras:open', { cwd: 'work' }],
        ['separator', '', {}],
        ['command', HomeCommandIDs.showLauncher, { widgetId: 'launcher-3' }]
      ]);
    } finally {
      menu.dispose();
    }
  });

  it('draws kernel icons from their URL and marks category headings', () => {
    const menu = buildToolsMenu({
      model: model(),
      commands: registry(),
      cwd: '',
      widgetId: 'launcher-0'
    });
    try {
      menu.open(0, 0);
      const icon = menu.node.querySelector<HTMLImageElement>(
        'img.jp-jupyterlab-lightcone-HomeTools-kernelIcon'
      );
      expect(icon?.getAttribute('src')).toBe('http://kernels/python3/logo.svg');
      const headings = Array.from(
        menu.node.querySelectorAll(
          '.jp-jupyterlab-lightcone-HomeTools-category'
        )
      ).map(node => node.textContent);
      expect(headings).toEqual(['Notebook', 'Other', 'Lightcone Labs Extras']);
    } finally {
      menu.dispose();
    }
  });

  it('offers only the full launcher when there are no other items', () => {
    const launcher = new LauncherModel();
    launcher.add({
      command: 'jupyterlab_lightcone:new-project',
      category: launcherCategory(null)
    });
    const menu = buildToolsMenu({
      model: launcher,
      commands: registry(),
      cwd: '',
      widgetId: 'launcher-1'
    });
    try {
      expect(menu.items.map(item => item.command)).toEqual([
        HomeCommandIDs.showLauncher
      ]);
    } finally {
      menu.dispose();
    }
  });
});
