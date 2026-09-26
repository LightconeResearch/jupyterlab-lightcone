import { LauncherModel } from '@jupyterlab/launcher';
import { CommandRegistry } from '@lumino/commands';
import type { Menu } from '@lumino/widgets';
import { HomeCommandIDs } from '../home-commands';
import { launcherCategory } from '../home-model';
import { ToolsMenu } from '../tools-menu';

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

/** The command and arguments of each item of a submenu. */
function entries(submenu: Menu | null): unknown[] | null {
  return submenu?.items.map(item => [item.command, item.args]) ?? null;
}

/** The submenus a menu holds, in order. */
function submenus(menu: Menu): Menu[] {
  return menu.items.flatMap(item => (item.submenu ? [item.submenu] : []));
}

describe('ToolsMenu', () => {
  it('groups every other launcher item by category with the tab cwd, then the full launcher', () => {
    const menu = new ToolsMenu({
      model: model(),
      commands: registry(),
      widgetId: 'launcher-3'
    });
    try {
      menu.refresh('work');
      expect(menu.items.map(item => [item.type, item.label])).toEqual([
        ['submenu', 'Notebook'],
        ['submenu', 'Other'],
        ['submenu', 'Lightcone Labs Extras'],
        ['separator', ''],
        ['command', 'Show the full launcher']
      ]);
      expect(entries(menu.items[0].submenu)).toEqual([
        ['notebook:create-new', { kernelName: 'python3', cwd: 'work' }]
      ]);
      expect(entries(menu.items[1].submenu)).toEqual([
        ['terminal:create-new', { cwd: 'work' }]
      ]);
      expect(entries(menu.items[2].submenu)).toEqual([
        ['extras:open', { cwd: 'work' }]
      ]);
      expect(menu.items[4].command).toBe(HomeCommandIDs.showLauncher);
      expect(menu.items[4].args).toEqual({ widgetId: 'launcher-3' });

      // Opening again fills the same menu for the folder of that moment.
      const first = submenus(menu);
      menu.refresh('elsewhere');
      expect(menu.items).toHaveLength(5);
      expect(first.every(submenu => submenu.isDisposed)).toBe(true);
      expect(entries(menu.items[1].submenu)).toEqual([
        ['terminal:create-new', { cwd: 'elsewhere' }]
      ]);
    } finally {
      menu.dispose();
    }
  });

  it('draws kernel icons from their URL', () => {
    const menu = new ToolsMenu({
      model: model(),
      commands: registry(),
      widgetId: 'launcher-0'
    });
    try {
      menu.refresh('');
      const notebooks = menu.items[0].submenu;
      notebooks?.open(0, 0);
      const icon = notebooks?.node.querySelector<HTMLImageElement>(
        'img.jp-jupyterlab-lightcone-HomeTools-kernelIcon'
      );
      expect(icon?.getAttribute('src')).toBe('http://kernels/python3/logo.svg');
      notebooks?.close();
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
    const menu = new ToolsMenu({
      model: launcher,
      commands: registry(),
      widgetId: 'launcher-1'
    });
    try {
      menu.refresh('');
      expect(menu.items.map(item => item.command)).toEqual([
        HomeCommandIDs.showLauncher
      ]);
    } finally {
      menu.dispose();
    }
  });

  it('disposes its submenus with itself', () => {
    const menu = new ToolsMenu({
      model: model(),
      commands: registry(),
      widgetId: 'launcher-2'
    });
    menu.refresh('work');
    const held = submenus(menu);
    expect(held).toHaveLength(3);
    menu.dispose();
    expect(menu.isDisposed).toBe(true);
    expect(held.every(submenu => submenu.isDisposed)).toBe(true);
  });
});
