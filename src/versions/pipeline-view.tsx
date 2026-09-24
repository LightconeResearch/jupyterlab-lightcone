import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import { Signal, type ISignal } from '@lumino/signaling';
import { AstraKindMark } from '../astra-kind';
import { CommandIDs } from '../commands';
import { useProject } from '../element-widget';
import { astraIcon } from '../icons';
import {
  outputMaterializationStatus,
  useMaterializationStatus
} from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import { LightconeThemeBinding } from '../theme-adapter';
import {
  buildPipelineGraph,
  downstreamOf,
  edgeInTrace,
  edgeRoute,
  inTrace,
  traceOf,
  type IPipelineGeometry,
  type IPipelineGraph,
  type IPipelineNode,
  type IPipelinePoint,
  type IPipelineTrace
} from './pipeline-graph';

const PAD = 24;
const COLUMN = 250;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 50;
const ROW = 68;
const LABEL_LENGTH = 26;
/** Where a node's meta line starts: after its kind mark. */
const META_X = 42;
/** The box the kind mark is drawn in, before the meta line. */
const MARK_SIZE = 14;

type NodeStatus = 'current' | 'behind' | 'stale' | 'unknown' | 'input';

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function nodeX(node: IPipelineNode): number {
  return PAD + node.layer * COLUMN;
}

function nodeY(node: IPipelineNode): number {
  return PAD + node.row * ROW;
}

const GEOMETRY: IPipelineGeometry = {
  pad: PAD,
  column: COLUMN,
  nodeWidth: NODE_WIDTH,
  nodeHeight: NODE_HEIGHT,
  row: ROW
};

/**
 * An SVG path through an edge's route: a smooth curve between columns and a
 * straight run across each column it skips.
 */
function edgePath(points: readonly IPipelinePoint[]): string {
  const [first, ...rest] = points;
  let path = `M${first.x},${first.y}`;
  let previous = first;
  rest.forEach((point, index) => {
    // Odd positions after the start leave a skipped column: straight across.
    if (index % 2 === 1 && index < rest.length - 1) {
      path += ` L${point.x},${point.y}`;
    } else {
      const bend = Math.max(24, (point.x - previous.x) / 2);
      path += ` C${previous.x + bend},${previous.y} ${point.x - bend},${point.y} ${point.x},${point.y}`;
    }
    previous = point;
  });
  return path;
}

/** "5 inputs and 1 output": the records of `paths` other than `self`. */
function recordCount(
  paths: ReadonlySet<string>,
  self: string,
  byPath: ReadonlyMap<string, IPipelineNode>
): string {
  let inputs = 0;
  let outputs = 0;
  for (const path of paths) {
    if (path === self) continue;
    if (byPath.get(path)?.kind === 'input') inputs += 1;
    else outputs += 1;
  }
  const parts: string[] = [];
  if (inputs) parts.push(`${inputs} input${inputs === 1 ? '' : 's'}`);
  if (outputs) parts.push(`${outputs} output${outputs === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

/**
 * What the trace shows, in words: what the record is made from and what it
 * feeds, so the lit graph reads without counting nodes.
 */
export function describeTrace(
  node: IPipelineNode,
  trace: IPipelineTrace,
  byPath: ReadonlyMap<string, IPipelineNode>
): string {
  const parts: string[] = [];
  const upstream = recordCount(trace.upstream, node.path, byPath);
  if (upstream) parts.push(`made from ${upstream}`);
  else if (node.kind === 'output') parts.push('declares no inputs');
  const downstream = recordCount(trace.downstream, node.path, byPath);
  if (downstream) parts.push(`feeds ${downstream}`);
  else
    parts.push(
      node.kind === 'input' ? 'used by no output' : 'feeds no other output'
    );
  return parts.join(' · ');
}

/** Scroll `container` so `target` sits in the middle of it, as far as it can. */
function centerIn(container: HTMLElement, target: Element): void {
  const box = container.getBoundingClientRect();
  const node = target.getBoundingClientRect();
  container.scrollLeft +=
    node.left + node.width / 2 - (box.left + box.width / 2);
  container.scrollTop +=
    node.top + node.height / 2 - (box.top + box.height / 2);
}

interface IPipelineViewProps {
  entrypoint: string;
  contents: Contents.IManager;
  commands: CommandRegistry;
  /** Canonical path of the traced record; the whole project when absent. */
  focus?: string;
  /** Bumped when the traced node should be scrolled into view. */
  reveal: number;
  /** Trace a record, or show everything with `undefined`. */
  onFocus: (path: string | undefined) => void;
}

function PipelineGraph({
  entrypoint,
  contents,
  commands,
  focus,
  reveal,
  onFocus,
  data
}: IPipelineViewProps & { data: ILoadedProjectData }): React.ReactElement {
  const graph: IPipelineGraph = useMemo(
    () => buildPipelineGraph(data.index),
    [data.index]
  );
  const materialization = useMaterializationStatus(
    contents,
    entrypoint,
    data.document
  );
  const [hovered, setHovered] = useState<string>();
  const byPath = useMemo(
    () => new Map(graph.nodes.map(node => [node.path, node])),
    [graph]
  );
  // A record that left the project traces nothing: the view shows everything.
  const traced = focus ? byPath.get(focus) : undefined;
  const trace = useMemo(
    () => (traced ? traceOf(graph, traced.path) : undefined),
    [graph, traced]
  );
  // Hovering shows what a rerun of that node would touch, over the trace.
  const lit: IPipelineTrace | undefined = useMemo(
    () =>
      hovered
        ? {
            upstream: new Set([hovered]),
            downstream: downstreamOf(graph, hovered)
          }
        : trace,
    [graph, hovered, trace]
  );
  const scroller = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  useEffect(() => {
    const container = scroller.current;
    if (!traced || !container || reveal === revealed.current) return;
    const target = Array.from(
      container.querySelectorAll<SVGGElement>(
        '.jp-jupyterlab-lightcone-Pipeline-node'
      )
    ).find(item => item.dataset.path === traced.path);
    if (!target) return;
    revealed.current = reveal;
    centerIn(container, target);
  }, [reveal, traced]);
  const statusOf = (node: IPipelineNode): NodeStatus => {
    if (node.kind === 'input') return 'input';
    const record = data.index.recordByPath.get(node.path);
    if (record?.kind !== 'output') return 'unknown';
    return (
      outputMaterializationStatus(materialization.statuses, data, record)
        ?.state ?? 'unknown'
    );
  };
  const counts = graph.nodes.reduce(
    (tally, node) => {
      tally[statusOf(node)] += 1;
      return tally;
    },
    { current: 0, behind: 0, stale: 0, unknown: 0, input: 0 }
  );
  const open = (node: IPipelineNode, newTab: boolean) => {
    // The graph follows what it opens: the record's lineage stays lit.
    onFocus(node.path);
    void commands
      .execute(CommandIDs.openElement, {
        entrypoint,
        target: node.path,
        universeId:
          data.document.universe.source === 'none'
            ? null
            : data.document.universe.universeId,
        newTab
      })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', String(reason))
      );
  };
  const width = PAD * 2 + Math.max(0, graph.layers - 1) * COLUMN + NODE_WIDTH;
  const height = PAD * 2 + Math.max(0, graph.rows - 1) * ROW + NODE_HEIGHT;
  const outputs = graph.nodes.filter(node => node.kind === 'output').length;
  return (
    <>
      <header className="jp-jupyterlab-lightcone-Pipeline-header">
        <div>
          <span className="jp-jupyterlab-lightcone-Pipeline-eyebrow">
            Pipeline
          </span>
          <h1>{data.document.analysis.name}</h1>
          <p>
            <AstraKindMark kind="input" /> {counts.input} input
            {counts.input === 1 ? '' : 's'} → <AstraKindMark kind="output" />{' '}
            {outputs} output
            {outputs === 1 ? '' : 's'} · universe{' '}
            <code>{data.document.universe.universeId}</code>
            {materialization.error && (
              <span role="status">
                {' '}
                · status unavailable: {materialization.error}
              </span>
            )}
          </p>
        </div>
        <ul
          className="jp-jupyterlab-lightcone-Pipeline-legend"
          aria-label="Legend"
        >
          <li data-status="current">{counts.current} current</li>
          <li data-status="behind">{counts.behind} behind</li>
          <li data-status="stale">{counts.stale} stale</li>
          <li data-status="input">inputs</li>
        </ul>
      </header>
      {traced && trace ? (
        <div className="jp-jupyterlab-lightcone-Pipeline-trace">
          <p role="status">
            Tracing <AstraKindMark kind={traced.kind} />{' '}
            <strong>{traced.label}</strong> ·{' '}
            {describeTrace(traced, trace, byPath)}
          </p>
          <button
            type="button"
            className="jp-jupyterlab-lightcone-Pipeline-clear"
            onClick={() => onFocus(undefined)}
          >
            Show everything
          </button>
        </div>
      ) : null}
      {graph.nodes.length === 0 ? (
        <p className="jp-jupyterlab-lightcone-Pipeline-empty" role="status">
          This project declares no inputs or outputs yet.
        </p>
      ) : (
        <div className="jp-jupyterlab-lightcone-Pipeline-scroll" ref={scroller}>
          <svg
            className="jp-jupyterlab-lightcone-Pipeline-graph"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Dependency graph of ${data.document.analysis.name}`}
          >
            <g className="jp-jupyterlab-lightcone-Pipeline-edges">
              {graph.edges.map(edge => {
                const from = byPath.get(edge.from);
                const to = byPath.get(edge.to);
                if (!from || !to) return null;
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    d={edgePath(edgeRoute(graph, from, to, GEOMETRY))}
                    data-kind={edge.kind}
                    data-highlighted={
                      lit && edgeInTrace(lit, edge) ? '' : undefined
                    }
                  />
                );
              })}
            </g>
            <g className="jp-jupyterlab-lightcone-Pipeline-nodes">
              {graph.nodes.map(node => {
                const status = statusOf(node);
                const dimmed = lit && !inTrace(lit, node.path);
                const isTraced = node.path === traced?.path;
                return (
                  <g
                    key={node.path}
                    className="jp-jupyterlab-lightcone-Pipeline-node"
                    transform={`translate(${nodeX(node)},${nodeY(node)})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${node.kind}: ${node.label} (${status})`}
                    aria-current={isTraced ? 'true' : undefined}
                    data-path={node.path}
                    data-kind={node.kind}
                    data-status={status}
                    data-dimmed={dimmed ? '' : undefined}
                    data-traced={isTraced ? '' : undefined}
                    onMouseEnter={() => setHovered(node.path)}
                    onMouseLeave={() => setHovered(undefined)}
                    onFocus={() => setHovered(node.path)}
                    onBlur={() => setHovered(undefined)}
                    onClick={event =>
                      open(node, event.ctrlKey || event.metaKey)
                    }
                    onAuxClick={event => {
                      if (event.button === 1) {
                        event.preventDefault();
                        open(node, true);
                      }
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open(node, event.ctrlKey || event.metaKey);
                      }
                    }}
                  >
                    <title>
                      {node.label} · {node.path} · {node.type} · {status}
                    </title>
                    <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={2} />
                    <circle cx={14} cy={NODE_HEIGHT / 2} r={5} />
                    <text x={28} y={21}>
                      {truncate(node.label, LABEL_LENGTH)}
                    </text>
                    {/* The inventory's kind mark, drawn by ASTRA UI itself. */}
                    <foreignObject
                      x={28}
                      y={38 - MARK_SIZE + 3}
                      width={MARK_SIZE}
                      height={MARK_SIZE}
                      className="jp-jupyterlab-lightcone-Pipeline-kind"
                    >
                      <AstraKindMark kind={node.kind} />
                    </foreignObject>
                    <text
                      x={META_X}
                      y={38}
                      className="jp-jupyterlab-lightcone-Pipeline-meta"
                    >
                      {truncate(
                        `${node.type}${node.analysisPath === '$' ? '' : ` · ${node.analysisPath}`}`,
                        LABEL_LENGTH + 2
                      )}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      )}
    </>
  );
}

function PipelineView(props: IPipelineViewProps): React.ReactElement {
  const state = useProject(props.contents, { entrypoint: props.entrypoint });
  const { focus, onFocus } = props;
  return (
    <main
      className="jp-jupyterlab-lightcone-Pipeline-page"
      onKeyDown={event => {
        if (event.key === 'Escape' && focus) {
          event.stopPropagation();
          onFocus(undefined);
        }
      }}
    >
      {state.error && (
        <p className="jp-jupyterlab-lightcone-refresh-warning" role="status">
          Showing last valid data, if available: {state.error}
        </p>
      )}
      {state.data ? (
        <PipelineGraph {...props} data={state.data} />
      ) : (
        <p className="jp-jupyterlab-lightcone-Pipeline-empty" role="status">
          {state.error ?? 'Loading the pipeline…'}
        </p>
      )}
    </main>
  );
}

/**
 * The inputs → outputs graph of one project, as a main-area widget. It can
 * trace one record: that record's lineage stays lit and the rest dims.
 */
export class PipelineWidget extends ReactWidget {
  constructor(
    readonly entrypoint: string,
    private readonly contents: Contents.IManager,
    themes: IThemeManager,
    private readonly commands: CommandRegistry,
    focus?: string
  ) {
    super();
    this._focus = focus;
    this._reveal = focus ? 1 : 0;
    this.addClass('jp-jupyterlab-lightcone-Pipeline');
    this.addClass('astra-ui');
    this.addClass('astra-isolate');
    this.addClass('lightcone-brand');
    this.title.label = 'Pipeline';
    this.title.icon = astraIcon;
    this.title.caption = `Pipeline · ${entrypoint}`;
    this.title.closable = true;
    this._theme = new LightconeThemeBinding(themes, this.node);
  }

  /** Canonical path of the traced record; the whole project when undefined. */
  get focus(): string | undefined {
    return this._focus;
  }

  /** Emitted with the traced record whenever it changes. */
  get focusChanged(): ISignal<this, string | undefined> {
    return this._focusChanged;
  }

  /**
   * Trace a record, or show everything with `undefined`. `reveal` scrolls
   * the traced node into view, for callers outside the graph; a click in the
   * graph leaves the scroll where it is.
   */
  setFocus(path: string | undefined, reveal = false): void {
    const changed = path !== this._focus;
    if (!changed && !(reveal && path)) return;
    this._focus = path;
    if (reveal && path) this._reveal += 1;
    if (changed) this._focusChanged.emit(path);
    this.update();
  }

  render(): React.ReactElement {
    return (
      <PipelineView
        entrypoint={this.entrypoint}
        contents={this.contents}
        commands={this.commands}
        focus={this._focus}
        reveal={this._reveal}
        onFocus={path => this.setFocus(path)}
      />
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._theme.dispose();
    super.dispose();
  }

  private readonly _theme: LightconeThemeBinding;
  private _focus: string | undefined;
  private _reveal: number;
  private readonly _focusChanged = new Signal<this, string | undefined>(this);
}
