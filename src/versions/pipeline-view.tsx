import React, { useMemo, useState } from 'react';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
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
  type IPipelineGraph,
  type IPipelineNode
} from './pipeline-graph';

const PAD = 24;
const COLUMN = 250;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 50;
const ROW = 68;
const LABEL_LENGTH = 26;

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

function edgePath(from: IPipelineNode, to: IPipelineNode): string {
  const x1 = nodeX(from) + NODE_WIDTH;
  const y1 = nodeY(from) + NODE_HEIGHT / 2;
  const x2 = nodeX(to);
  const y2 = nodeY(to) + NODE_HEIGHT / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}

interface IPipelineViewProps {
  entrypoint: string;
  contents: Contents.IManager;
  commands: CommandRegistry;
}

function PipelineGraph({
  entrypoint,
  contents,
  commands,
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
  const highlighted = useMemo(
    () => (hovered ? downstreamOf(graph, hovered) : undefined),
    [graph, hovered]
  );
  const byPath = useMemo(
    () => new Map(graph.nodes.map(node => [node.path, node])),
    [graph]
  );
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
            {counts.input} input{counts.input === 1 ? '' : 's'} → {outputs}{' '}
            output{outputs === 1 ? '' : 's'} · universe{' '}
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
      {graph.nodes.length === 0 ? (
        <p className="jp-jupyterlab-lightcone-Pipeline-empty" role="status">
          This project declares no inputs or outputs yet.
        </p>
      ) : (
        <div className="jp-jupyterlab-lightcone-Pipeline-scroll">
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
                    d={edgePath(from, to)}
                    data-kind={edge.kind}
                    data-highlighted={
                      highlighted?.has(edge.from) && highlighted.has(edge.to)
                        ? ''
                        : undefined
                    }
                  />
                );
              })}
            </g>
            <g className="jp-jupyterlab-lightcone-Pipeline-nodes">
              {graph.nodes.map(node => {
                const status = statusOf(node);
                const dimmed = highlighted && !highlighted.has(node.path);
                return (
                  <g
                    key={node.path}
                    className="jp-jupyterlab-lightcone-Pipeline-node"
                    transform={`translate(${nodeX(node)},${nodeY(node)})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${node.kind}: ${node.label} (${status})`}
                    data-kind={node.kind}
                    data-status={status}
                    data-dimmed={dimmed ? '' : undefined}
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
                    <text
                      x={28}
                      y={38}
                      className="jp-jupyterlab-lightcone-Pipeline-meta"
                    >
                      {truncate(
                        `${node.type}${node.analysisPath === '$' ? '' : ` · ${node.analysisPath}`}`,
                        LABEL_LENGTH + 4
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
  return (
    <main className="jp-jupyterlab-lightcone-Pipeline-page">
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

/** The inputs → outputs graph of one project, as a main-area widget. */
export class PipelineWidget extends ReactWidget {
  constructor(
    readonly entrypoint: string,
    private readonly contents: Contents.IManager,
    themes: IThemeManager,
    private readonly commands: CommandRegistry
  ) {
    super();
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

  render(): React.ReactElement {
    return (
      <PipelineView
        entrypoint={this.entrypoint}
        contents={this.contents}
        commands={this.commands}
      />
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._theme.dispose();
    super.dispose();
  }

  private readonly _theme: LightconeThemeBinding;
}
