import type { AnalysisIndex, ResolvedRecord } from '@astra-spec/sdk';
import { recordTitle } from '@astra-spec/ui/model';

export type PipelineNodeKind = 'input' | 'output';

/** One input or output of the project, placed on the layered graph. */
export interface IPipelineNode {
  /** Canonical record path, e.g. `outputs.hubble_diagram`. */
  path: string;
  id: string;
  label: string;
  kind: PipelineNodeKind;
  /** The record's declared type: figure, table, metric, data, analysis… */
  type: string;
  /** `$` for the root analysis, else the dotted analysis path. */
  analysisPath: string;
  /** Column, from sources on the left to final outputs on the right. */
  layer: number;
  /** Row within the column. */
  row: number;
}

/** A dependency: `to` is made from `from`. */
export interface IPipelineEdge {
  from: string;
  to: string;
  /** A declared input, or an alias (`from:`) of another record. */
  kind: 'input' | 'alias';
}

export interface IPipelineGraph {
  nodes: IPipelineNode[];
  edges: IPipelineEdge[];
  /** Number of columns. */
  layers: number;
  /** Height of the tallest column. */
  rows: number;
}

function isDataRecord(
  record: ResolvedRecord
): record is Extract<ResolvedRecord, { kind: 'input' | 'output' }> {
  return record.kind === 'input' || record.kind === 'output';
}

/**
 * Lay the project's inputs and outputs out as a layered DAG: every declared
 * input of an output, and every alias, is an edge. A node's column is one
 * past its farthest upstream node (a longest-path layering), and rows are
 * ordered by the average row of their predecessors so edges cross little.
 * Cycles, which the SDK rejects anyway, are broken at the back edge.
 */
export function buildPipelineGraph(
  index: Pick<AnalysisIndex, 'recordByPath' | 'analysisByRecordPath'>
): IPipelineGraph {
  const records = [...index.recordByPath.values()].filter(isDataRecord);
  const known = new Set(records.map(record => record.canonicalPath));
  const edges: IPipelineEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, kind: IPipelineEdge['kind']) => {
    const key = `${from}\u0000${to}`;
    if (from === to || !known.has(from) || !known.has(to) || seen.has(key))
      return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  for (const record of records) {
    if (record.kind === 'output') {
      for (const path of record.provenance.inputPaths)
        addEdge(path, record.canonicalPath, 'input');
    }
    if (record.resolvedFrom)
      addEdge(record.resolvedFrom, record.canonicalPath, 'alias');
  }
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    const list = predecessors.get(edge.to) ?? [];
    list.push(edge.from);
    predecessors.set(edge.to, list);
  }
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (path: string): number => {
    const done = layerOf.get(path);
    if (done !== undefined) return done;
    if (visiting.has(path)) return 0;
    visiting.add(path);
    let depth = 0;
    for (const upstream of predecessors.get(path) ?? [])
      depth = Math.max(depth, layer(upstream) + 1);
    visiting.delete(path);
    layerOf.set(path, depth);
    return depth;
  };
  const order = new Map(
    records.map((record, position) => [record.canonicalPath, position])
  );
  const nodes: IPipelineNode[] = records.map(record => ({
    path: record.canonicalPath,
    id: record.id,
    label: recordTitle(record),
    kind: record.kind,
    type: record.type,
    analysisPath:
      index.analysisByRecordPath.get(record.canonicalPath)?.canonicalPath ??
      '$',
    layer: layer(record.canonicalPath),
    row: 0
  }));
  const layers = nodes.length
    ? Math.max(...nodes.map(node => node.layer)) + 1
    : 0;
  const rowOf = new Map<string, number>();
  let rows = 0;
  for (let column = 0; column < layers; column += 1) {
    const members = nodes.filter(node => node.layer === column);
    const barycenter = (node: IPipelineNode): number => {
      const upstream = (predecessors.get(node.path) ?? [])
        .map(path => rowOf.get(path))
        .filter((row): row is number => row !== undefined);
      return upstream.length
        ? upstream.reduce((sum, row) => sum + row, 0) / upstream.length
        : Number.POSITIVE_INFINITY;
    };
    members.sort((a, b) => {
      const difference = barycenter(a) - barycenter(b);
      if (Number.isFinite(difference) && difference !== 0) return difference;
      if (Number.isFinite(barycenter(a)) !== Number.isFinite(barycenter(b)))
        return Number.isFinite(barycenter(a)) ? -1 : 1;
      return (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
    });
    members.forEach((node, row) => {
      node.row = row;
      rowOf.set(node.path, row);
    });
    rows = Math.max(rows, members.length);
  }
  return { nodes, edges, layers, rows };
}

/** Outputs downstream of a node, including itself: what a rerun would touch. */
export function downstreamOf(graph: IPipelineGraph, path: string): Set<string> {
  const result = new Set<string>([path]);
  const queue = [path];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of graph.edges)
      if (edge.from === current && !result.has(edge.to)) {
        result.add(edge.to);
        queue.push(edge.to);
      }
  }
  return result;
}
