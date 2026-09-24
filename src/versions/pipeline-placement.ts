import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { TabBar, Widget } from '@lumino/widgets';

/** Pipeline tabs carry this id prefix, followed by their project's path. */
export const PIPELINE_TAB_PREFIX = 'lightcone-pipeline-';

/** Whether a main-area widget is a project's pipeline tab. */
export function isPipelineTab(widget: Widget): boolean {
  return widget.id.startsWith(PIPELINE_TAB_PREFIX);
}

/** The part of the Lab shell that tells which tab area holds a widget. */
export interface IMainAreaGroups {
  getMainAreaTabBar(widget: Widget): TabBar<Widget> | null;
}

/**
 * Where the pipeline opens from a record tab. The graph needs a whole column
 * and the record should stay in view, so it joins the column beside the
 * record, preferably the nearest one on its left (where Home or the session
 * the record came from usually sits), and splits to the record's left only
 * when the record is alone in the main area. A node clicked in the graph
 * then opens its record back in the record's column.
 */
export function pipelinePlacement(
  record: Widget,
  mainWidgets: Iterable<Widget>,
  groups: IMainAreaGroups | null
): DocumentRegistry.IOpenOptions {
  const own = groups?.getMainAreaTabBar(record);
  if (!groups || !own) {
    return { mode: 'split-left', ref: record.id };
  }
  const recordLeft = own.node.getBoundingClientRect().left;
  const columns = new Map<TabBar<Widget>, number>();
  for (const widget of mainWidgets) {
    const bar = groups.getMainAreaTabBar(widget);
    if (bar && bar !== own && bar.currentTitle && !columns.has(bar)) {
      columns.set(bar, bar.node.getBoundingClientRect().left);
    }
  }
  let beside: TabBar<Widget> | undefined;
  let besideLeft = 0;
  for (const [bar, left] of columns) {
    const onLeft = left < recordLeft;
    const bestOnLeft = beside !== undefined && besideLeft < recordLeft;
    // The nearest column on the left wins; without one, the leftmost other.
    const better =
      beside === undefined ||
      (onLeft && (!bestOnLeft || left > besideLeft)) ||
      (!onLeft && !bestOnLeft && left < besideLeft);
    if (better) {
      beside = bar;
      besideLeft = left;
    }
  }
  const owner = beside?.currentTitle?.owner;
  return owner
    ? { mode: 'tab-after', ref: owner.id }
    : { mode: 'split-left', ref: record.id };
}
