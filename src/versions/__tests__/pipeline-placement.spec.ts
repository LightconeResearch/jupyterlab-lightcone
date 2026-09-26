import type { DockLayout } from '@lumino/widgets';
import { Widget } from '@lumino/widgets';
import {
  isPipelineTab,
  PIPELINE_TAB_PREFIX,
  pipelinePlacement
} from '../pipeline-placement';

/** A main area described like the dock saves it: columns of tab areas. */
function mainArea(columns: (string[] | string[][])[]) {
  const widgets = new Map<string, Widget>();
  const widget = (id: string) => {
    let known = widgets.get(id);
    if (!known) {
      known = new Widget();
      known.id = id;
      widgets.set(id, known);
    }
    return known;
  };
  const tabArea = (ids: string[]): DockLayout.ITabAreaConfig => ({
    type: 'tab-area',
    widgets: ids.map(widget),
    currentIndex: 0
  });
  const isNested = (column: string[] | string[][]): column is string[][] =>
    Array.isArray(column[0]);
  const children: DockLayout.AreaConfig[] = columns.map(column =>
    isNested(column)
      ? {
          type: 'split-area',
          orientation: 'vertical',
          children: column.map(tabArea),
          sizes: column.map(() => 1)
        }
      : tabArea(column)
  );
  const layout: DockLayout.ILayoutConfig = {
    main:
      children.length === 1
        ? children[0]
        : {
            type: 'split-area',
            orientation: 'horizontal',
            children,
            sizes: children.map(() => 1)
          }
  };
  return { layout, byId: widget };
}

test('the pipeline joins the column on the record’s left', () => {
  const area = mainArea([['home', 'notes'], ['record']]);
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual({
    mode: 'tab-after',
    ref: 'home'
  });
});

test('the nearest column on the left wins over farther ones', () => {
  const area = mainArea([['session'], ['home'], ['record'], ['doc']]);
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual({
    mode: 'tab-after',
    ref: 'home'
  });
});

test('without a column on the left, the pipeline takes the leftmost other', () => {
  const area = mainArea([['record'], ['home'], ['doc']]);
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual({
    mode: 'tab-after',
    ref: 'home'
  });
});

test('a record stacked above another tab area still finds the column beside it', () => {
  const area = mainArea([['home'], [['record'], ['terminal']]]);
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual({
    mode: 'tab-after',
    ref: 'home'
  });
});

test('the column joined is the tab it shows, not its first tab', () => {
  const area = mainArea([['notes', 'home'], ['record']]);
  const column = area.layout.main;
  if (column?.type !== 'split-area' || column.children[0].type !== 'tab-area')
    throw new Error('The fixture is not a row of columns.');
  column.children[0].currentIndex = 1;
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual({
    mode: 'tab-after',
    ref: 'home'
  });
});

test('a record alone, or no layout to ask, splits to the record’s left', () => {
  const area = mainArea([['record', 'other-record']]);
  const split = { mode: 'split-left', ref: 'record' };
  expect(pipelinePlacement(area.byId('record'), area.layout)).toEqual(split);
  expect(pipelinePlacement(area.byId('record'), null)).toEqual(split);
  expect(pipelinePlacement(area.byId('record'), { main: null })).toEqual(split);
  // A record the layout does not hold yet cannot be placed by it either.
  const other = mainArea([['home'], ['doc']]);
  expect(pipelinePlacement(area.byId('record'), other.layout)).toEqual(split);
});

test('pipeline tabs are recognized by their id', () => {
  const tab = new Widget();
  tab.id = `${PIPELINE_TAB_PREFIX}b6c1`;
  const other = new Widget();
  other.id = 'lightcone-element-1';
  expect(isPipelineTab(tab)).toBe(true);
  expect(isPipelineTab(other)).toBe(false);
});
