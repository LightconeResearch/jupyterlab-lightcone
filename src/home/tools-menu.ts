import type { ILauncher } from '@jupyterlab/launcher';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { MenuSvg } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import { h, type VirtualElement } from '@lumino/virtualdom';
import type { Menu } from '@lumino/widgets';
import { HomeCommandIDs } from './home-commands';
import { groupLauncherItems, isLightconeCategory } from './home-model';

const KERNEL_ICON_CLASS = 'jp-jupyterlab-lightcone-HomeTools-kernelIcon';

/** Renders kernel icons from their spec URL, as the stock launcher cards do. */
class ToolsMenuRenderer extends MenuSvg.Renderer {
  constructor(private readonly kernelIcons: WeakMap<Menu.IItem, string>) {
    super();
  }

  renderIcon(data: Menu.IRenderData): VirtualElement {
    const url = this.kernelIcons.get(data.item);
    if (url) {
      return h.img({
        className: `lm-Menu-itemIcon ${KERNEL_ICON_CLASS}`,
        src: url,
        alt: ''
      });
    }
    return super.renderIcon(data);
  }
}

export interface IToolsMenuOptions {
  model: ILauncher.IModel;
  commands: CommandRegistry;
  /** The Home tab the menu belongs to, for "Show the full launcher". */
  widgetId: string;
  translator?: ITranslator;
}

/**
 * The Tools menu of a Home tab: one submenu per launcher category, each item
 * executing the same command with the same arguments as its stock card, then
 * an entry that switches the tab to the stock launcher body. The menu lives
 * as long as its tab and is filled again before each opening, for the
 * launcher items and working directory of that moment.
 */
export class ToolsMenu extends MenuSvg {
  constructor(options: IToolsMenuOptions) {
    const kernelIcons = new WeakMap<Menu.IItem, string>();
    super({
      commands: options.commands,
      renderer: new ToolsMenuRenderer(kernelIcons)
    });
    this._kernelIcons = kernelIcons;
    this._model = options.model;
    this._widgetId = options.widgetId;
    this._trans = (options.translator ?? nullTranslator).load('jupyterlab');
    this.addClass('jp-jupyterlab-lightcone-HomeTools');
  }

  /** Fill the menu for the tab's working directory; an open menu closes first. */
  refresh(cwd: string): void {
    this.clearItems();
    this._clearSubmenus();
    const groups = groupLauncherItems(this._model.items(), this.commands, cwd, {
      labels: {
        notebook: this._trans.__('Notebook'),
        console: this._trans.__('Console'),
        other: this._trans.__('Other')
      },
      // Home offers Lightcone's own launcher cards in its body, not in Tools.
      exclude: item => isLightconeCategory(item.category)
    });
    for (const group of groups) {
      const submenu = new MenuSvg({
        commands: this.commands,
        renderer: this.renderer
      });
      submenu.title.label = group.category;
      for (const item of group.items) {
        const added = submenu.addItem({
          command: item.command,
          args: { ...item.args, cwd }
        });
        if (item.kernelIconUrl) {
          this._kernelIcons.set(added, item.kernelIconUrl);
        }
      }
      this._submenus.push(submenu);
      this.addItem({ type: 'submenu', submenu });
    }
    if (groups.length) {
      this.addItem({ type: 'separator' });
    }
    this.addItem({
      command: HomeCommandIDs.showLauncher,
      args: { widgetId: this._widgetId }
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._clearSubmenus();
    super.dispose();
  }

  // Lumino disposes no submenu with its parent.
  private _clearSubmenus(): void {
    for (const submenu of this._submenus) {
      submenu.dispose();
    }
    this._submenus = [];
  }

  private readonly _kernelIcons: WeakMap<Menu.IItem, string>;
  private readonly _model: ILauncher.IModel;
  private readonly _widgetId: string;
  private readonly _trans: ReturnType<ITranslator['load']>;
  private _submenus: MenuSvg[] = [];
}
