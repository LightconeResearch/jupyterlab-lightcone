import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  MainAreaWidget,
  showErrorMessage,
  WidgetTracker
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IRunningSessionManagers } from '@jupyterlab/running';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import {
  buildIcon,
  refreshIcon,
  runIcon,
  ToolbarButton
} from '@jupyterlab/ui-components';
import { UUID, type ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ICurrentProject } from '../current-project';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';
import { startMaterialization } from './materialize';
import { addRunningSection } from './running-section';
import { type RunsCommandArguments, RunsCommandIDs } from './runs-commands';
import { startErrorMessage } from './runs-model';
import { RunsService } from './runs-service';
import { RunsWidget } from './runs-widget';

export * from './runs-commands';

const CATEGORY = 'Lightcone Lab';

/** A string argument, or undefined when it is absent or not a string. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read the open-runs arguments; malformed ones count as absent. */
function openRunsArgs(
  args: ReadonlyPartialJSONObject
): RunsCommandArguments.IOpenRuns {
  return {
    entrypoint: stringArg(args.entrypoint),
    cwd: stringArg(args.cwd),
    activate: typeof args.activate === 'boolean' ? args.activate : undefined
  };
}

/** Read the materialize arguments; malformed ones count as absent. */
function materializeArgs(
  args: ReadonlyPartialJSONObject
): RunsCommandArguments.IMaterialize {
  return {
    entrypoint: stringArg(args.entrypoint),
    cwd: stringArg(args.cwd),
    targets: Array.isArray(args.targets)
      ? args.targets.filter(
          (target): target is string => typeof target === 'string'
        )
      : [],
    refresh: args.refresh === true
  };
}

/** Materialization jobs, their live output and the project's run history. */
export const runsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:runs',
  description:
    'Start and follow lc materialize, and browse the materialization history.',
  autoStart: true,
  optional: [
    ICurrentProject,
    IDocumentManager,
    ILayoutRestorer,
    ICommandPalette,
    IRunningSessionManagers,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject | null,
    documents: IDocumentManager | null,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null,
    running: IRunningSessionManagers | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const contents = app.serviceManager.contents;
    const service = new RunsService(
      app.serviceManager.serverSettings,
      app.serviceManager.events
    );
    const tracker = new WidgetTracker<MainAreaWidget<RunsWidget>>({
      namespace: 'lightcone-runs'
    });
    app.shell.disposed.connect(() => {
      service.dispose();
      tracker.dispose();
    });

    /** Explicit entrypoint, then folder, then the focused document, then the browser's project. */
    const resolveEntrypoint = async (
      args: Pick<RunsCommandArguments.IOpenRuns, 'entrypoint' | 'cwd'>
    ): Promise<string> => {
      if (args.entrypoint !== undefined) {
        return contents.normalize(args.entrypoint);
      }
      if (args.cwd !== undefined) {
        const root = await findProjectRoot(contents, args.cwd);
        if (root) {
          return root.entrypoint;
        }
        throw new Error(
          trans.__(
            'No Lightcone project contains %1.',
            args.cwd || trans.__('the server root')
          )
        );
      }
      const widget = app.shell.currentWidget;
      const context =
        widget && documents ? documents.contextForWidget(widget) : undefined;
      if (context) {
        try {
          const root = await findProjectRoot(
            contents,
            projectDirectory(context.path)
          );
          if (root) {
            return root.entrypoint;
          }
        } catch {
          // A document outside every project falls through to the browser's.
        }
      }
      if (current?.project) {
        return current.project.entrypoint;
      }
      throw new Error(
        trans.__('Open a folder inside a Lightcone project first.')
      );
    };

    const openRuns = async (
      entrypoint: string,
      activate = true
    ): Promise<MainAreaWidget<RunsWidget>> => {
      const key = PathExt.normalize(entrypoint);
      let widget = tracker.find(item => item.content.entrypoint === key);
      if (!widget) {
        const content = new RunsWidget(
          key,
          service,
          contents,
          app.commands,
          translator ?? undefined
        );
        widget = new MainAreaWidget({ content });
        widget.id = `lightcone-runs-${UUID.uuid4()}`;
        widget.toolbar.addItem(
          'materialize',
          new ToolbarButton({
            icon: buildIcon,
            label: trans.__('Materialize'),
            tooltip: trans.__('Materialize every stale output'),
            onClick: () => {
              void app.commands.execute(RunsCommandIDs.materialize, {
                entrypoint: key
              });
            }
          })
        );
        widget.toolbar.addItem(
          'refresh',
          new ToolbarButton({
            icon: refreshIcon,
            tooltip: trans.__('Refresh runs'),
            onClick: () => {
              void service.refresh(key).catch(() => undefined);
            }
          })
        );
        await tracker.add(widget);
        // Beside whatever the user is looking at, so Runs never displaces it.
        const ref = app.shell.currentWidget?.id;
        app.shell.add(widget, 'main', {
          mode: 'tab-after',
          ...(ref ? { ref } : {}),
          activate
        });
      } else {
        void service.refresh(key).catch(() => undefined);
        if (activate) {
          app.shell.activateById(widget.id);
        }
      }
      return widget;
    };

    app.commands.addCommand(RunsCommandIDs.openRuns, {
      label: trans.__('Runs'),
      caption: trans.__(
        'Materialization jobs and history of the current Lightcone project'
      ),
      icon: runIcon,
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
            cwd: { type: 'string' },
            activate: { type: 'boolean' }
          }
        }
      },
      execute: async raw => {
        const args = openRunsArgs(raw);
        try {
          const entrypoint = await resolveEntrypoint(args);
          return await openRuns(entrypoint, args.activate !== false);
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not open Lightcone runs'),
            error instanceof Error ? error.message : String(error)
          );
          return undefined;
        }
      }
    });

    app.commands.addCommand(RunsCommandIDs.materialize, {
      label: trans.__('Materialize outputs'),
      caption: trans.__(
        'Run lc materialize for the current Lightcone project and follow it in Runs'
      ),
      icon: buildIcon,
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
            cwd: { type: 'string' },
            targets: { type: 'array', items: { type: 'string' } },
            refresh: { type: 'boolean' }
          }
        }
      },
      execute: async raw => {
        const {
          targets = [],
          refresh = false,
          ...where
        } = materializeArgs(raw);
        let entrypoint: string;
        try {
          entrypoint = await resolveEntrypoint(where);
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not start materialization'),
            error instanceof Error ? error.message : String(error)
          );
          return undefined;
        }
        try {
          const job = await startMaterialization({
            service,
            entrypoint,
            targets,
            refresh,
            openRuns: () => {
              void openRuns(entrypoint).catch(() => undefined);
            }
          });
          await openRuns(entrypoint);
          return job;
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not start materialization'),
            startErrorMessage(error)
          );
          return undefined;
        }
      }
    });

    palette?.addItem({ command: RunsCommandIDs.openRuns, category: CATEGORY });
    palette?.addItem({
      command: RunsCommandIDs.materialize,
      category: CATEGORY
    });

    if (restorer) {
      void restorer.restore(tracker, {
        command: RunsCommandIDs.openRuns,
        args: widget => ({
          entrypoint: widget.content.entrypoint,
          activate: false
        }),
        name: widget => widget.content.entrypoint
      });
    }

    if (running) {
      addRunningSection(running, {
        service,
        openRuns: entrypoint => {
          void openRuns(entrypoint).catch(error => {
            console.warn('Could not open Lightcone runs.', error);
          });
        }
      });
    }

    // Jobs started before a reload appear in the Running panel once the
    // browser's project is known; events are not replayed.
    if (current) {
      const sync = () => {
        const entrypoint = current.project?.entrypoint;
        if (entrypoint) {
          void service.refresh(entrypoint).catch(() => undefined);
        }
      };
      current.changed.connect(sync);
      sync();
    }
  }
};
