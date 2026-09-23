import {
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
import { ElementHistoryCommandIDs } from './element-history';
import { PipelineWidget } from './pipeline-view';

export namespace VersionsCommandIDs {
  export const openPipeline = 'jupyterlab_lightcone:open-pipeline';
}

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
  optional: [ICurrentProject, ILayoutRestorer, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    themes: IThemeManager,
    current: ICurrentProject | null,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null
  ) => {
    const contents = app.serviceManager.contents;
    const tracker = new WidgetTracker<MainAreaWidget<PipelineWidget>>({
      namespace: 'lightcone-pipeline'
    });
    app.commands.addCommand(VersionsCommandIDs.openPipeline, {
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
          let widget = tracker.find(
            item => item.content.entrypoint === entrypoint
          );
          if (!widget) {
            widget = new MainAreaWidget({
              content: new PipelineWidget(
                entrypoint,
                contents,
                themes,
                app.commands
              )
            });
            widget.id = `lightcone-pipeline-${entrypoint.replace(/[^a-zA-Z0-9]+/g, '-')}`;
            app.shell.add(widget, 'main');
            await tracker.add(widget);
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
        command: VersionsCommandIDs.openPipeline,
        args: widget => ({ entrypoint: widget.content.entrypoint }),
        name: widget => `pipeline:${widget.content.entrypoint}`
      });
    }
    palette?.addItem({
      command: VersionsCommandIDs.openPipeline,
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
