import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { DockLayout, Widget } from '@lumino/widgets';

/** Pipeline tabs carry this id prefix, followed by a UUID. */
export const PIPELINE_TAB_PREFIX = 'lightcone-pipeline-';

/** Whether a main-area widget is a project's pipeline tab. */
export function isPipelineTab(widget: Widget): boolean {
  return widget.id.startsWith(PIPELINE_TAB_PREFIX);
}

/** The areas from the dock's root down to the tab area holding `widget`. */
function pathTo(
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
function shownWidget(area: DockLayout.AreaConfig): Widget | undefined {
  if (area.type === 'tab-area') {
    return area.widgets[area.currentIndex] ?? area.widgets[0];
  }
  for (const child of area.children) {
    const shown = shownWidget(child);
    if (shown) return shown;
  }
  return undefined;
}

/**
 * Where the pipeline opens from a record tab. The graph needs a whole column
 * and the record should stay in view, so it joins the column beside the
 * record, preferably the nearest one on its left (where Home or the session
 * the record came from usually sits), and splits to the record's left only
 * when the record is alone in the main area. A node clicked in the graph
 * then opens its record back in the record's column.
 *
 * `layout` is the dock's saved layout (`ILabShell.saveLayout().mainArea.dock`):
 * its split tree gives the column order without measuring anything.
 */
export function pipelinePlacement(
  record: Widget,
  layout: DockLayout.ILayoutConfig | null
): DocumentRegistry.IOpenOptions {
  const split: DocumentRegistry.IOpenOptions = {
    mode: 'split-left',
    ref: record.id
  };
  const path = layout?.main ? pathTo(layout.main, record) : undefined;
  if (!path) return split;
  // The nearest horizontal split around the record decides the column.
  for (let depth = path.length - 2; depth >= 0; depth -= 1) {
    const area = path[depth];
    if (area.type !== 'split-area' || area.orientation !== 'horizontal') {
      continue;
    }
    const index = area.children.indexOf(path[depth + 1]);
    // The column immediately on the left; without one, the leftmost other.
    const beside =
      index > 0
        ? area.children[index - 1]
        : area.children.find((child, position) => position !== index);
    const shown = beside ? shownWidget(beside) : undefined;
    if (shown) return { mode: 'tab-after', ref: shown.id };
  }
  return split;
}
