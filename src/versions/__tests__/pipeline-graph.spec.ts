import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  buildPipelineGraph,
  downstreamOf,
  edgeInTrace,
  edgeRoute,
  inTrace,
  traceOf,
  upstreamOf,
  type IPipelineGeometry
} from '../pipeline-graph';

const yaml = `version: "0.0.14"
name: Pipeline
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
  - id: covariance
    type: data
    source: data/cov.npz
outputs:
  - id: fit
    type: metric
    format: json
    inputs: [catalog, covariance]
    recipe:
      command: uv run fit.py
  - id: plot
    type: figure
    format: png
    inputs: [fit]
    recipe:
      command: uv run plot.py
  - id: table
    type: table
    format: csv
    inputs: [fit, catalog]
    recipe:
      command: uv run table.py
`;

async function graphFor(document: string) {
  const { contents } = createContents({
    'astra.yaml': fileModel(document)
  });
  try {
    const { bundle } = await resolveProject(contents);
    return buildPipelineGraph(assembleLoadedProject(bundle, {}).index);
  } finally {
    contents.dispose();
  }
}

test('layers inputs before the outputs made from them', async () => {
  const graph = await graphFor(yaml);
  const layer = Object.fromEntries(
    graph.nodes.map(node => [node.path, node.layer])
  );
  expect(layer).toEqual({
    'inputs.catalog': 0,
    'inputs.covariance': 0,
    'outputs.fit': 1,
    'outputs.plot': 2,
    'outputs.table': 2
  });
  expect(graph.layers).toBe(3);
  expect(graph.rows).toBe(2);
  expect(graph.edges).toEqual(
    expect.arrayContaining([
      { from: 'inputs.catalog', to: 'outputs.fit', kind: 'input' },
      { from: 'inputs.covariance', to: 'outputs.fit', kind: 'input' },
      { from: 'outputs.fit', to: 'outputs.plot', kind: 'input' },
      { from: 'outputs.fit', to: 'outputs.table', kind: 'input' },
      { from: 'inputs.catalog', to: 'outputs.table', kind: 'input' }
    ])
  );
  expect(graph.edges).toHaveLength(5);
  const rows = Object.fromEntries(
    graph.nodes.map(node => [node.path, node.row])
  );
  // Rows are unique within a column and follow document order among peers.
  expect(
    new Set([rows['inputs.catalog'], rows['inputs.covariance']]).size
  ).toBe(2);
  expect(rows['outputs.plot']).toBe(0);
  expect(rows['outputs.table']).toBe(1);
  const plot = graph.nodes.find(node => node.path === 'outputs.plot')!;
  expect(plot).toMatchObject({
    id: 'plot',
    kind: 'output',
    type: 'figure',
    analysisPath: '$'
  });
});

test('finds what a rerun would touch downstream of a node', async () => {
  const graph = await graphFor(yaml);
  expect([...downstreamOf(graph, 'inputs.covariance')].sort()).toEqual([
    'inputs.covariance',
    'outputs.fit',
    'outputs.plot',
    'outputs.table'
  ]);
  expect([...downstreamOf(graph, 'outputs.plot')]).toEqual(['outputs.plot']);
});

test('traces what a node is made from and what it feeds', async () => {
  const graph = await graphFor(yaml);
  expect([...upstreamOf(graph, 'outputs.plot')].sort()).toEqual([
    'inputs.catalog',
    'inputs.covariance',
    'outputs.fit',
    'outputs.plot'
  ]);
  expect([...upstreamOf(graph, 'inputs.catalog')]).toEqual(['inputs.catalog']);
  const trace = traceOf(graph, 'outputs.fit');
  expect([...trace.upstream].sort()).toEqual([
    'inputs.catalog',
    'inputs.covariance',
    'outputs.fit'
  ]);
  expect([...trace.downstream].sort()).toEqual([
    'outputs.fit',
    'outputs.plot',
    'outputs.table'
  ]);
  expect(graph.nodes.filter(node => !inTrace(trace, node.path))).toEqual([]);
  const lit = graph.edges
    .filter(edge => edgeInTrace(trace, edge))
    .map(edge => `${edge.from}->${edge.to}`)
    .sort();
  // catalog -> table skips the traced fit, so it stays unlit.
  expect(lit).toEqual([
    'inputs.catalog->outputs.fit',
    'inputs.covariance->outputs.fit',
    'outputs.fit->outputs.plot',
    'outputs.fit->outputs.table'
  ]);
  // A leaf output traces its whole upstream and nothing below.
  const plot = traceOf(graph, 'outputs.plot');
  expect(inTrace(plot, 'outputs.table')).toBe(false);
  expect(
    edgeInTrace(plot, { from: 'inputs.catalog', to: 'outputs.table' })
  ).toBe(false);
});

test('handles a project without inputs or outputs', async () => {
  expect(
    await graphFor('version: "0.0.14"\nname: Empty\ninputs: []\noutputs: []\n')
  ).toEqual({ nodes: [], edges: [], layers: 0, rows: 0 });
});

test('edges cross the columns they skip between nodes, never under one', async () => {
  const graph = await graphFor(yaml);
  const geometry: IPipelineGeometry = {
    pad: 24,
    column: 250,
    nodeWidth: 200,
    nodeHeight: 50,
    row: 68
  };
  const byPath = new Map(graph.nodes.map(node => [node.path, node]));
  const route = (from: string, to: string) =>
    edgeRoute(graph, byPath.get(from)!, byPath.get(to)!, geometry);
  // Adjacent columns: straight from the source's right side to the target.
  expect(route('outputs.fit', 'outputs.plot')).toHaveLength(2);
  // The catalog feeds the table two columns on, past the fit.
  const skip = route('inputs.catalog', 'outputs.table');
  expect(skip).toHaveLength(4);
  const [start, enter, leave, end] = skip;
  expect(start.x).toBe(24 + 200);
  expect(end.x).toBe(24 + 2 * 250);
  expect(enter).toEqual({ x: 24 + 250, y: enter.y });
  expect(leave).toEqual({ x: 24 + 250 + 200, y: enter.y });
  for (const node of graph.nodes.filter(item => item.layer === 1)) {
    const top = 24 + node.row * 68;
    expect(enter.y < top || enter.y > top + 50).toBe(true);
  }
});
