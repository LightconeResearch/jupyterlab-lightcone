import type { TabBar } from '@lumino/widgets';
import { Widget } from '@lumino/widgets';
import {
  isPipelineTab,
  PIPELINE_TAB_PREFIX,
  pipelinePlacement,
  type IMainAreaGroups
} from '../pipeline-placement';

/** A main area of columns, each a tab bar at `left` holding widgets. */
function mainArea(columns: { left: number; ids: string[] }[]) {
  const bars = new Map<Widget, TabBar<Widget>>();
  const widgets: Widget[] = [];
  for (const column of columns) {
    const node = document.createElement('div');
    node.getBoundingClientRect = () => ({ left: column.left }) as DOMRect;
    const owned = column.ids.map(id => {
      const widget = new Widget();
      widget.id = id;
      return widget;
    });
    const bar = {
      node,
      currentTitle: owned.length ? { owner: owned[0] } : null
    } as unknown as TabBar<Widget>;
    for (const widget of owned) {
      bars.set(widget, bar);
      widgets.push(widget);
    }
  }
  const groups: IMainAreaGroups = {
    getMainAreaTabBar: widget => bars.get(widget) ?? null
  };
  const byId = (id: string) => widgets.find(widget => widget.id === id)!;
  return { widgets, groups, byId };
}

test('the pipeline joins the column on the record’s left', () => {
  const area = mainArea([
    { left: 0, ids: ['home', 'notes'] },
    { left: 500, ids: ['record'] }
  ]);
  expect(
    pipelinePlacement(area.byId('record'), area.widgets, area.groups)
  ).toEqual({ mode: 'tab-after', ref: 'home' });
});

test('the nearest column on the left wins over farther ones', () => {
  const area = mainArea([
    { left: 0, ids: ['session'] },
    { left: 300, ids: ['home'] },
    { left: 600, ids: ['record'] },
    { left: 900, ids: ['doc'] }
  ]);
  expect(
    pipelinePlacement(area.byId('record'), area.widgets, area.groups)
  ).toEqual({ mode: 'tab-after', ref: 'home' });
});

test('without a column on the left, the pipeline takes one on the right', () => {
  const area = mainArea([
    { left: 0, ids: ['record'] },
    { left: 700, ids: ['doc'] },
    { left: 400, ids: ['home'] }
  ]);
  expect(
    pipelinePlacement(area.byId('record'), area.widgets, area.groups)
  ).toEqual({ mode: 'tab-after', ref: 'home' });
});

test('a record alone, or no shell to ask, splits to the record’s left', () => {
  const area = mainArea([{ left: 0, ids: ['record', 'other-record'] }]);
  const split = { mode: 'split-left', ref: 'record' };
  expect(
    pipelinePlacement(area.byId('record'), area.widgets, area.groups)
  ).toEqual(split);
  expect(pipelinePlacement(area.byId('record'), area.widgets, null)).toEqual(
    split
  );
});

test('pipeline tabs are recognized by their id', () => {
  const tab = new Widget();
  tab.id = `${PIPELINE_TAB_PREFIX}project-astra-yaml`;
  const other = new Widget();
  other.id = 'lightcone-element-1';
  expect(isPipelineTab(tab)).toBe(true);
  expect(isPipelineTab(other)).toBe(false);
});
