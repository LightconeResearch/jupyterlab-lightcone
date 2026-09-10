import { chatIcon, IChatTracker } from '@jupyter/chat';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { PathExt } from '@jupyterlab/coreutils';
import { CommandIDs } from './commands';
import { ServerConnection } from '@jupyterlab/services';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { parseElementReference } from './element-reference';
import { InventoryDocument } from './document-widget';

/** Optional integration with Jupyter AI's chat UI; inventory and record tabs work independently. */
export const chatPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat',
  description: 'ASTRA preview cards and agent navigation in Jupyter AI chats.',
  autoStart: true,
  optional: [
    IChatTracker,
    ICommandPalette,
    IFileBrowserFactory,
    ILauncher,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: IChatTracker | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
    launcher: ILauncher | null,
    translator: ITranslator | null
  ) => {
    if (!tracker) return;
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
          const entrypoint =
            typeof args.entrypoint === 'string'
              ? args.entrypoint
              : typeof args.cwd === 'string'
                ? PathExt.join(args.cwd, 'astra.yaml')
                : current instanceof InventoryDocument
                  ? current.context.path
                  : PathExt.join(
                      browser?.tracker.currentWidget?.model.path ?? '',
                      'astra.yaml'
                    );
          const reference = parseElementReference({
            ...args,
            entrypoint,
            target: typeof args.target === 'string' ? args.target : ''
          });
          // Match the inventory shortcut's guidance before creating any chat file.
          try {
            await app.serviceManager.contents.get(reference.entrypoint, {
              content: false
            });
          } catch (error) {
            if (
              error instanceof ServerConnection.ResponseError &&
              error.response.status === 404
            ) {
              await showErrorMessage(
                trans.__('No ASTRA project found'),
                trans.__(
                  'No ASTRA project file was found at "%1". Open a folder containing astra.yaml in the file browser, then choose Lightcone Agent.',
                  reference.entrypoint
                )
              );
              return null;
            }
            throw error;
          }
          const directory = PathExt.dirname(reference.entrypoint);
          // Explicit record shortcuts may reuse an open chat in the same folder.
          let panel =
            reference.target || reference.doi
              ? tracker.find(
                  item =>
                    !item.isDisposed &&
                    item.area === 'sidebar' &&
                    PathExt.dirname(item.model.name) === directory
                )
              : undefined;
          const reused = !!panel;
          const draft = panel?.model.input.value ?? '';
          const filepath: unknown = panel
            ? panel.model.name
            : await app.commands.execute('jupyterlab-chat:create', {
                path: PathExt.dirname(reference.entrypoint),
                inSidePanel: true
              });
          if (typeof filepath !== 'string' || !filepath)
            throw new Error('The chat could not be created.');
          // A newly opened sidebar chat returns null; locate its tracked panel by path.
          // The native open command also reveals the sidebar and selects a reused chat.
          await app.commands.execute('jupyterlab-chat:open', {
            filepath,
            inSidePanel: true
          });
          panel = tracker.find(
            item => item.area === 'sidebar' && item.model.name === filepath
          );
          if (!panel)
            throw new Error(
              'The chat did not open. Check that Jupyter AI is enabled.'
            );
          const id = await panel.model.ready;
          if (reference.target || reference.doi)
            panel.model.input.value = `${draft}${draft ? '\n\n' : ''}Discuss ASTRA element ${reference.doi ? `DOI ${reference.doi}` : reference.target}.`;
          panel.model.input.focus();
          return { entrypoint: reference.entrypoint, chatId: id, reused };
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
    launcher?.add({
      command: CommandIDs.discuss,
      category: 'Lightcone Lab',
      categoryRank: -10,
      rank: 0
    });
  }
};
