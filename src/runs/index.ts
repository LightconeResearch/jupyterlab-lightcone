import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { buildIcon } from '@jupyterlab/ui-components';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ICurrentProject } from '../current-project';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';
import { startMaterialization } from './materialize';
import { type RunsCommandArguments, RunsCommandIDs } from './runs-commands';
import { startErrorMessage } from './runs-model';
import { RunsService } from './runs-service';

export * from './runs-commands';

const CATEGORY = 'Lightcone Lab';

/** A string argument, or undefined when it is absent or not a string. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

/**
 * `lc materialize` started from the UI (Home's and the sidebar's
 * Rematerialize, or the palette), followed by one notification until it ends.
 */
export const runsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:runs',
  description: 'Start lc materialize from the UI and follow it.',
  autoStart: true,
  optional: [ICurrentProject, IDocumentManager, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject | null,
    documents: IDocumentManager | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const contents = app.serviceManager.contents;
    const service = new RunsService(
      app.serviceManager.serverSettings,
      app.serviceManager.events
    );
    app.shell.disposed.connect(() => {
      service.dispose();
    });

    /** Explicit entrypoint, then folder, then the focused document, then the browser's project. */
    const resolveEntrypoint = async (
      args: Pick<RunsCommandArguments.IMaterialize, 'entrypoint' | 'cwd'>
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

    app.commands.addCommand(RunsCommandIDs.materialize, {
      label: trans.__('Materialize outputs'),
      caption: trans.__(
        'Run lc materialize for the current Lightcone project and follow it in a notification'
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
          return await startMaterialization({
            service,
            entrypoint,
            targets,
            refresh
          });
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not start materialization'),
            startErrorMessage(error)
          );
          return undefined;
        }
      }
    });

    palette?.addItem({
      command: RunsCommandIDs.materialize,
      category: CATEGORY
    });
  }
};
