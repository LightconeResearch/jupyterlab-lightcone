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
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { requireProject } from '../commands';
import { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import { SessionManager } from './session-manager';
import { SessionPlaceholderFactory } from './session-placeholder';
import { ISessionService } from './session-service';

export {
  ISessionService,
  type ISessionStartOptions,
  type SessionState
} from './session-service';
export {
  listSessions,
  prepareSessions,
  type ISessionInfo,
  type ISessionListing,
  type SessionActivity
} from './sessions-api';
export {
  SessionManager,
  isChatPanel,
  isRecordTab,
  isSessionWidget,
  personaMetadata,
  selectedPersona,
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
  readToolCalls,
  type ActivityTransition,
  type ISessionSnapshot
} from './session-activity';

const CATEGORY = 'Lightcone Lab';

export namespace SessionsCommandIDs {
  /** Create a session in the current project and open it in the main area. */
  export const newSession = 'jupyterlab_lightcone:new-session';
  /** Open, or activate, the session stored at a chat path. */
  export const openSession = 'jupyterlab_lightcone:open-session';
}

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

/** Provide `ISessionService` and the commands Home, the sidebar and search call. */
export const sessionsPlugin: JupyterFrontEndPlugin<ISessionService> = {
  id: 'jupyterlab_lightcone:sessions',
  description:
    'Project-scoped Jupyter AI sessions: list, create and open them in the main area.',
  autoStart: true,
  provides: ISessionService,
  requires: [ICurrentProject],
  optional: [
    IChatTracker,
    IChatCommandRegistry,
    ILabShell,
    ICommandPalette,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    tracker: IChatTracker | null,
    chatCommands: IChatCommandRegistry | null,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): ISessionService => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const sessions = new SessionManager({
      commands: app.commands,
      shell: app.shell,
      contents: app.serviceManager.contents,
      tracker,
      chatCommands,
      labShell,
      events: app.serviceManager.events,
      translator: translator ?? undefined
    });
    app.shell.disposed.connect(() => sessions.dispose());

    app.commands.addCommand(SessionsCommandIDs.newSession, {
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
          const entrypoint = optionalString(args, 'entrypoint');
          const cwd = optionalString(args, 'cwd');
          let root: IProjectRoot | undefined;
          if (entrypoint) {
            root = await requireProject(app, { entrypoint });
          } else if (cwd !== undefined) {
            root = await requireProject(app, { directory: cwd });
          } else if (current.project) {
            root = current.project;
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
            title: optionalString(args, 'title'),
            firstMessage: optionalString(args, 'firstMessage'),
            persona: optionalString(args, 'persona')
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

    app.commands.addCommand(SessionsCommandIDs.openSession, {
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
        const path = optionalString(args, 'path');
        if (!path) {
          throw new Error('A session path is required.');
        }
        try {
          await sessions.openSession(path);
        } catch (error) {
          await showErrorMessage(
            trans.__('Could not open the session'),
            error instanceof Error ? error : String(error)
          );
        }
      }
    });

    palette?.addItem({
      command: SessionsCommandIDs.newSession,
      category: CATEGORY
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
