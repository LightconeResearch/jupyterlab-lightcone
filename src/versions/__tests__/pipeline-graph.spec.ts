import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { buildPipelineGraph, downstreamOf } from '../pipeline-graph';

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

test('handles a project without inputs or outputs', async () => {
  expect(
    await graphFor('version: "0.0.14"\nname: Empty\ninputs: []\noutputs: []\n')
  ).toEqual({ nodes: [], edges: [], layers: 0, rows: 0 });
});
