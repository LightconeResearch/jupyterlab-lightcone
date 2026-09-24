import {
  ILabShell,
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  MainAreaWidget,
  showErrorMessage,
  WidgetTracker
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { ICurrentProject } from '../current-project';
import { astraIcon } from '../icons';
import { findProjectRoot } from '../project-root';
import { isRecordTab } from '../sessions/session-manager';
import { ElementHistoryCommandIDs } from './element-history';
import { PipelineCommandIDs } from './pipeline-commands';
import { PIPELINE_TAB_PREFIX, pipelinePlacement } from './pipeline-placement';
import { PipelineWidget } from './pipeline-view';

const CATEGORY = 'Lightcone Lab';

/**
 * Versions, provenance and the pipeline view. Record tabs show versions and
 * provenance through `element-widget`; this plugin adds the pipeline command
 * and lists the record-tab history commands in the palette.
 */
export const versionsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:versions',
  description: 'Output versions, provenance tabs and the pipeline view.',
  autoStart: true,
  requires: [IThemeManager],
  optional: [ICurrentProject, ILayoutRestorer, ICommandPalette, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    themes: IThemeManager,
    current: ICurrentProject | null,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null,
    labShell: ILabShell | null
  ) => {
    const contents = app.serviceManager.contents;
    const tracker = new WidgetTracker<MainAreaWidget<PipelineWidget>>({
      namespace: 'lightcone-pipeline'
    });
    app.commands.addCommand(PipelineCommandIDs.openPipeline, {
      label: 'Pipeline',
      caption: 'Show how this project makes its outputs from its inputs',
      icon: astraIcon,
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: {
              type: 'string',
              description: 'Project astra.yaml contents path'
            },
            path: {
              type: 'string',
              description: 'Project astra.yaml contents path'
            },
            cwd: {
              type: 'string',
              description: 'A folder inside the project'
            },
            focus: {
              type: 'string',
              description:
                'Canonical path of the input or output to trace, e.g. outputs.hubble_diagram'
            }
          }
        }
      },
      execute: async args => {
        try {
          let entrypoint: string | undefined;
          if (typeof args.entrypoint === 'string') entrypoint = args.entrypoint;
          else if (typeof args.path === 'string') entrypoint = args.path;
          else if (typeof args.cwd === 'string')
            entrypoint = (await findProjectRoot(contents, args.cwd))
              ?.entrypoint;
          else entrypoint = current?.project?.entrypoint;
          if (!entrypoint) {
            throw new Error(
              'Open a folder inside a Lightcone project first, or pass its astra.yaml path.'
            );
          }
          entrypoint = PathExt.normalize(entrypoint);
          const focus =
            typeof args.focus === 'string' && args.focus
              ? args.focus
              : undefined;
          let widget = tracker.find(
            item => item.content.entrypoint === entrypoint
          );
          if (widget) {
            // The open pipeline retraces in place: it keeps its spot.
            widget.content.setFocus(focus, true);
          } else {
            const content = new PipelineWidget(
              entrypoint,
              contents,
              themes,
              app.commands,
              focus
            );
            const created = new MainAreaWidget({ content });
            widget = created;
            widget.id = `${PIPELINE_TAB_PREFIX}${entrypoint.replace(/[^a-zA-Z0-9]+/g, '-')}`;
            // From a record, the graph takes the column beside it, so the
            // record stays in view (see `pipelinePlacement`).
            const source = app.shell.currentWidget;
            app.shell.add(
              widget,
              'main',
              source && isRecordTab(source)
                ? pipelinePlacement(source, app.shell.widgets('main'), labShell)
                : undefined
            );
            await tracker.add(widget);
            content.focusChanged.connect(() => void tracker.save(created));
          }
          app.shell.activateById(widget.id);
          return widget;
        } catch (error) {
          await showErrorMessage(
            'Could not open the pipeline',
            error instanceof Error ? error : String(error)
          );
          return undefined;
        }
      }
    });
    if (restorer) {
      void restorer.restore(tracker, {
        command: PipelineCommandIDs.openPipeline,
        args: widget => ({
          entrypoint: widget.content.entrypoint,
          ...(widget.content.focus ? { focus: widget.content.focus } : {})
        }),
        name: widget => `pipeline:${widget.content.entrypoint}`
      });
    }
    palette?.addItem({
      command: PipelineCommandIDs.openPipeline,
      category: CATEGORY
    });
    for (const command of [
      ElementHistoryCommandIDs.back,
      ElementHistoryCommandIDs.forward,
      ElementHistoryCommandIDs.openInNewTab
    ])
      palette?.addItem({ command, category: CATEGORY });
  }
};
