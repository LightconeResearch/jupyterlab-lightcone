import { CommandRegistry } from '@lumino/commands';
import { Menu } from '@lumino/widgets';

/** One line of a disposable menu: an action, a heading, or a separator. */
export type DisposableMenuItem =
  | { kind: 'action'; label: string; caption?: string; execute: () => void }
  | { kind: 'heading'; label: string }
  | { kind: 'separator' };

/**
 * A menu with a private command registry that disposes itself once closed.
 */
export function buildDisposableMenu(
  items: readonly DisposableMenuItem[],
  className: string
): Menu {
  const commands = new CommandRegistry();
  const menu = new Menu({ commands });
  menu.addClass(className);
  items.forEach((item, index) => {
    if (item.kind === 'separator') {
      menu.addItem({ type: 'separator' });
      return;
    }
    const id = `item:${index}`;
    commands.addCommand(id, {
      label: item.label,
      caption: item.kind === 'action' ? (item.caption ?? '') : '',
      describedBy: { args: { type: 'object', properties: {} } },
      isEnabled: () => item.kind === 'action',
      execute: () => (item.kind === 'action' ? item.execute() : undefined)
    });
    menu.addItem({ command: id });
  });
  menu.aboutToClose.connect(() => {
    // Lumino still reads the menu while the close event runs.
    window.setTimeout(() => menu.dispose(), 0);
  });
  return menu;
}

/** Open a menu below the element that asked for it. */
export function openBelow(menu: Menu, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.open(rect.left, rect.bottom + 2);
}
