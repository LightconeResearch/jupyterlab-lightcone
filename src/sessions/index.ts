import {
  chatIcon,
  IChatBodyPlaceholderFactory,
  IChatCommandRegistry,
  IChatTracker
} from '@jupyter/chat';
import {
  ILabShell,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { CommandIDs, requireProject } from '../commands';
import { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import { PALETTE_CATEGORY } from '../workbench-ids';
import { resolvePersonaRegistry } from './persona-registry';
import { SessionManager } from './session-manager';
import { SessionPlaceholderFactory } from './session-placeholder';
import { ISessionService } from './session-service';

export {
  ISessionService,
  type ISessionStartOptions,
  type SessionState
} from './session-service';
export { agentContinuityPlugin } from './agent-continuity';
export {
  fetchProjectAgent,
  listSessions,
  type ISessionInfo,
  type ISessionListing,
  type SessionActivity
} from './sessions-api';
export {
  SessionManager,
  isChatPanel,
  isComposerStamp,
  isRecordTab,
  isSessionWidget,
  personaMetadata,
  selectedPersona,
  trackedSession,
  type ISessionManagerOptions
} from './session-manager';
export {
  sessionStem,
  slugForTitle,
  titleForSession,
  titleFromMessage,
  uniqueSessionName
} from './session-titles';
export {
  activityTransition,
  deriveSessionState,
  hasPendingPermission,
  isPersonaUser,
  listActivity,
  type ActivityTransition,
  type ISessionSnapshot
} from './session-activity';
export { readToolCalls, type IToolCall } from './acp-metadata';

export namespace SessionsCommandArguments {
  export interface INewSession {
    /** The project's `astra.yaml`; the current project when absent. */
    entrypoint?: string;
    /** A folder to locate the project from when `entrypoint` is absent. */
    cwd?: string;
    title?: string;
    firstMessage?: string;
    persona?: string;
  }

  export interface IOpenSession {
    /** Contents path of the `.chat` file. */
    path: string;
  }
}

function optionalString(
  args: ReadonlyPartialJSONObject,
  key: string
): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read `new-session` arguments; a value of the wrong type counts as absent. */
export function readNewSessionArgs(
  args: ReadonlyPartialJSONObject
): SessionsCommandArguments.INewSession {
  return {
    entrypoint: optionalString(args, 'entrypoint'),
    cwd: optionalString(args, 'cwd'),
    title: optionalString(args, 'title'),
    firstMessage: optionalString(args, 'firstMessage'),
    persona: optionalString(args, 'persona')
  };
}

/** Read `open-session` arguments, or null without a usable chat path. */
export function readOpenSessionArgs(
  args: ReadonlyPartialJSONObject
): SessionsCommandArguments.IOpenSession | null {
  const path = optionalString(args, 'path');
  return path ? { path } : null;
}

/**
 * Provide project-session commands and `ISessionService` when Jupyter Chat is
 * available. Consumers can take the service optionally and omit session
 * controls when chat support is absent. The persona manager's public registry
 * supplies live activity, with the server event stream as a fallback.
 */
export const sessionsPlugin: JupyterFrontEndPlugin<ISessionService> = {
  id: 'jupyterlab_lightcone:sessions',
  description:
    'Project-scoped Jupyter AI sessions: list, create and open them in the main area.',
  autoStart: true,
  provides: ISessionService,
  requires: [ICurrentProject, IChatTracker, IDocumentManager],
  optional: [
    IChatCommandRegistry,
    ILabShell,
    ICommandPalette,
    IFileBrowserFactory,
    ITranslator
  ],
  activate: async (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    tracker: IChatTracker,
    documents: IDocumentManager,
    chatCommands: IChatCommandRegistry | null,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
    translator: ITranslator | null
  ): Promise<ISessionService> => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const registry = await resolvePersonaRegistry(app);
    const sessions = new SessionManager({
      commands: app.commands,
      shell: app.shell,
      contents: app.serviceManager.contents,
      documents,
      tracker,
      chatCommands,
      labShell,
      events: app.serviceManager.events,
      registry,
      translator: translator ?? undefined
    });
    app.shell.disposed.connect(() => {
      sessions.dispose();
    });

    app.commands.addCommand(CommandIDs.newSession, {
      label: trans.__('New session'),
      caption: trans.__('Start a new agent session in this Lightcone project'),
      icon: chatIcon.bindprops({
        className: 'jp-jupyterlab-lightcone-AssistantIcon'
      }),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
            cwd: { type: 'string' },
            title: { type: 'string' },
            firstMessage: { type: 'string' },
            persona: { type: 'string' }
          }
        }
      },
      execute: async args => {
        try {
          const { entrypoint, cwd, title, firstMessage, persona } =
            readNewSessionArgs(args);
          let root: IProjectRoot | undefined;
          if (entrypoint) {
            root = await requireProject(app, { entrypoint });
          } else if (cwd !== undefined) {
            root = await requireProject(app, { directory: cwd });
          } else if (current.project) {
            root = current.project;
          } else if (current.project === undefined) {
            // The current project is still being looked up, or the lookup
            // failed: locate it from the file browser's folder directly.
            root = await requireProject(app, {
              directory: browser?.tracker.currentWidget?.model.path ?? ''
            });
          } else {
            // `requireProject` offers setup itself; only a missing current
            // project needs an explanation.
            await showErrorMessage(
              trans.__('No Lightcone project'),
              trans.__(
                'Browse into a Lightcone project in the file browser to start a session.'
              )
            );
            return null;
          }
          if (!root) {
            return null;
          }
          return await sessions.createAndOpen(root.entrypoint, {
            title,
            firstMessage,
            persona
          });
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not start the session'),
            error instanceof Error ? error : String(error)
          );
          return null;
        }
      }
    });

    app.commands.addCommand(CommandIDs.openSession, {
      label: trans.__('Open session'),
      caption: trans.__('Open a Lightcone session in the main area'),
      describedBy: {
        args: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } }
        }
      },
      execute: async args => {
        const target = readOpenSessionArgs(args);
        if (!target) {
          throw new Error('A session path is required.');
        }
        try {
          await sessions.openSession(target.path);
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not open the session'),
            error instanceof Error ? error : String(error)
          );
        }
      }
    });

    palette?.addItem({
      command: CommandIDs.newSession,
      category: PALETTE_CATEGORY
    });
    return sessions;
  }
};

/** Show the project's name in an empty session instead of Jupyter Chat's blank body. */
export const sessionPlaceholderPlugin: JupyterFrontEndPlugin<IChatBodyPlaceholderFactory> =
  {
    id: 'jupyterlab_lightcone:session-placeholder',
    description: 'The empty-session placeholder naming the current project.',
    autoStart: true,
    provides: IChatBodyPlaceholderFactory,
    optional: [ITranslator],
    activate: (
      app: JupyterFrontEnd,
      translator: ITranslator | null
    ): IChatBodyPlaceholderFactory =>
      new SessionPlaceholderFactory(
        app.serviceManager.contents,
        translator ?? undefined
      )
  };
