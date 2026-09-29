import type { DockLayout, Widget } from '@lumino/widgets';

/**
 * Reading the main area's saved layout (`ILabShell.saveLayout().mainArea.dock`)
 * to place a tab beside another: its split tree gives the column order
 * without measuring anything.
 */

/** The areas from the dock's root down to the tab area holding `widget`. */
export function pathTo(
  area: DockLayout.AreaConfig,
  widget: Widget
): DockLayout.AreaConfig[] | undefined {
  if (area.type === 'tab-area') {
    return area.widgets.includes(widget) ? [area] : undefined;
  }
  for (const child of area.children) {
    const below = pathTo(child, widget);
    if (below) return [area, ...below];
  }
  return undefined;
}

/** The widget an area shows: its current tab, or its first child's. */
export function shownWidget(area: DockLayout.AreaConfig): Widget | undefined {
  if (area.type === 'tab-area') {
    return area.widgets[area.currentIndex] ?? area.widgets[0];
  }
  for (const child of area.children) {
    const shown = shownWidget(child);
    if (shown) return shown;
  }
  return undefined;
}
