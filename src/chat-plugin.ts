import { chatIcon, IChatTracker, type IChatPanel } from '@jupyter/chat';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { CommandIDs, requireProject } from './commands';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { parseElementReference } from './element-reference';
import { projectDirectory } from './project-data';
import { findProjectRoot, type IProjectRoot } from './project-root';
import { InventoryDocument } from './document-widget';
import { ISessionService } from './sessions/session-service';
import { isSessionWidget } from './sessions/session-manager';

/**
 * The open session of a project, preferring the one the user works in.
 *
 * Only chats under the project folder can belong to it; a nested project may
 * still own them, so those candidates are confirmed. An unreadable chat
 * elsewhere must not fail the whole command.
 */
async function findProjectSession(
  app: JupyterFrontEnd,
  tracker: IChatTracker,
  root: IProjectRoot
): Promise<IChatPanel | undefined> {
  const contents = app.serviceManager.contents;
  const drive = contents.driveName(root.entrypoint);
  const underProject = (chat: string) => {
    let directory: string;
    try {
      directory = projectDirectory(chat);
    } catch {
      return undefined;
    }
    return contents.driveName(directory) === drive &&
      (!root.path ||
        directory === root.path ||
        directory.startsWith(`${root.path}/`))
      ? directory
      : undefined;
  };
  const candidates: IChatPanel[] = [];
  const directories: string[] = [];
  const consider = (item: IChatPanel) => {
    if (item.isDisposed || !isSessionWidget(item)) {
      return;
    }
    const directory = underProject(item.model.name);
    if (directory === undefined || candidates.includes(item)) {
      return;
    }
    candidates.push(item);
    directories.push(directory);
  };
  const current = app.shell.currentWidget;
  if (isSessionWidget(current)) {
    consider(current);
  }
  tracker.forEach(consider);
  const owners = await Promise.all(
    directories.map(directory =>
      findProjectRoot(contents, directory).catch(() => undefined)
    )
  );
  return candidates.find(
    (_item, index) => owners[index]?.entrypoint === root.entrypoint
  );
}

/**
 * Optional integration with Jupyter AI's chat UI; inventory and record tabs
 * work independently. Without Jupyter Chat there is neither a tracker nor a
 * session service, and `discuss` is not registered.
 */
export const chatPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat',
  description: 'ASTRA preview cards and agent navigation in Jupyter AI chats.',
  autoStart: true,
  optional: [
    ISessionService,
    IChatTracker,
    ICommandPalette,
    IFileBrowserFactory,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    sessions: ISessionService | null,
    tracker: IChatTracker | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
    translator: ITranslator | null
  ) => {
    if (!sessions || !tracker) {
      return;
    }
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    app.commands.addCommand(CommandIDs.discuss, {
      label: trans.__('Lightcone Agent'),
      caption: trans.__('Open Lightcone Agent for this ASTRA project'),
      icon: chatIcon.bindprops({
        className: 'jp-jupyterlab-lightcone-AssistantIcon'
      }),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
            cwd: { type: 'string' },
            target: { type: 'string' }
          }
        }
      },
      execute: async args => {
        try {
          const current = app.shell.currentWidget;
          // Match the inventory shortcut's guidance before creating any chat file.
          const root = await requireProject(
            app,
            typeof args.entrypoint === 'string'
              ? { entrypoint: args.entrypoint }
              : typeof args.cwd === 'string'
                ? { directory: args.cwd }
                : current instanceof InventoryDocument
                  ? { entrypoint: current.context.path }
                  : {
                      directory:
                        browser?.tracker.currentWidget?.model.path ?? ''
                    }
          );
          if (!root) {
            return null;
          }
          const { entrypoint, target } = parseElementReference({
            entrypoint: root.entrypoint,
            target: typeof args.target === 'string' ? args.target : ''
          });
          // The server roots the agent in whichever project owns the chat file,
          // so any session open in this project can take the conversation.
          let panel = await findProjectSession(app, tracker, root);
          const reused = !!panel;
          let filepath: string;
          if (panel) {
            filepath = panel.model.name;
            await sessions.openSession(filepath);
          } else {
            filepath = await sessions.createAndOpen(entrypoint, {
              title: target ? `Discuss ${target}` : undefined
            });
            const local = app.serviceManager.contents.localPath(filepath);
            panel = tracker.find(
              item =>
                isSessionWidget(item) &&
                app.serviceManager.contents.localPath(item.model.name) === local
            );
          }
          if (!panel) {
            throw new Error(
              trans.__(
                'The session did not open. Check that Jupyter AI is enabled.'
              )
            );
          }
          await panel.model.ready;
          const draft = panel.model.input.value;
          if (target) {
            panel.model.input.value = `${draft}${draft ? '\n\n' : ''}Discuss ASTRA element ${target}.`;
          }
          panel.model.input.focus();
          return { entrypoint, reused, path: filepath };
        } catch (reason) {
          await showErrorMessage(
            trans.__('Could not open Lightcone Agent'),
            reason instanceof Error ? reason : String(reason)
          );
          return null;
        }
      }
    });
    palette?.addItem({
      command: CommandIDs.discuss,
      category: 'Lightcone Lab'
    });
  }
};
