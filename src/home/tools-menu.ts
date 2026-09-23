import type { ILauncher } from '@jupyterlab/launcher';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { MenuSvg } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import { h, type VirtualElement } from '@lumino/virtualdom';
import type { Menu } from '@lumino/widgets';
import { HomeCommandIDs } from './home-commands';
import { groupLauncherItems } from './home-model';

/** Home offers Lightcone's own launcher cards in its body, not in Tools. */
const LIGHTCONE_CATEGORY_PREFIX = 'Lightcone Lab';

const KERNEL_ICON_CLASS = 'jp-jupyterlab-lightcone-HomeTools-kernelIcon';
const CATEGORY_CLASS = 'jp-jupyterlab-lightcone-HomeTools-category';

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

  createItemClass(data: Menu.IRenderData): string {
    const base = super.createItemClass(data);
    return data.item.command === HomeCommandIDs.toolsCategory
      ? `${base} ${CATEGORY_CLASS}`
      : base;
  }
}

export interface IToolsMenuOptions {
  model: ILauncher.IModel;
  commands: CommandRegistry;
  /** The launcher tab's working directory, passed to every command. */
  cwd: string;
  /** The Home tab the menu belongs to, for "Show the full launcher". */
  widgetId: string;
  translator?: ITranslator;
}

/**
 * Build the Tools menu: every launcher item grouped by category, executing
 * the same command with the same arguments as its stock card, then an entry
 * that switches the tab to the stock launcher body. The caller disposes it.
 */
export function buildToolsMenu(options: IToolsMenuOptions): MenuSvg {
  const { model, commands, cwd, widgetId } = options;
  const trans = (options.translator ?? nullTranslator).load('jupyterlab');
  const kernelIcons = new WeakMap<Menu.IItem, string>();
  const menu = new MenuSvg({
    commands,
    renderer: new ToolsMenuRenderer(kernelIcons)
  });
  menu.addClass('jp-jupyterlab-lightcone-HomeTools');
  const groups = groupLauncherItems(model.items(), commands, cwd, {
    labels: {
      notebook: trans.__('Notebook'),
      console: trans.__('Console'),
      other: trans.__('Other')
    },
    exclude: item => (item.category ?? '').startsWith(LIGHTCONE_CATEGORY_PREFIX)
  });
  for (const group of groups) {
    menu.addItem({
      command: HomeCommandIDs.toolsCategory,
      args: { category: group.category }
    });
    for (const item of group.items) {
      const added = menu.addItem({
        command: item.command,
        args: { ...item.args, cwd }
      });
      if (item.kernelIconUrl) {
        kernelIcons.set(added, item.kernelIconUrl);
      }
    }
  }
  if (groups.length) {
    menu.addItem({ type: 'separator' });
  }
  menu.addItem({ command: HomeCommandIDs.showLauncher, args: { widgetId } });
  return menu;
}
