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
import { findProjectRoot } from './project-root';
import { InventoryDocument } from './document-widget';

/** Optional integration with Jupyter AI's chat UI; inventory and record tabs work independently. */
export const chatPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat',
  description: 'ASTRA preview cards and agent navigation in Jupyter AI chats.',
  autoStart: true,
  optional: [IChatTracker, ICommandPalette, IFileBrowserFactory, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: IChatTracker | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
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
          if (!root) return null;
          const reference = parseElementReference({
            ...args,
            entrypoint: root.entrypoint,
            target: typeof args.target === 'string' ? args.target : ''
          });
          // The server roots the agent in whichever project owns the chat file,
          // so a record shortcut may reuse any open chat stored in this project.
          let panel: IChatPanel | undefined;
          if (reference.target || reference.doi) {
            const open: IChatPanel[] = [];
            tracker.forEach(item => {
              if (!item.isDisposed && item.area === 'sidebar') open.push(item);
            });
            for (const item of open) {
              const owner = await findProjectRoot(
                app.serviceManager.contents,
                projectDirectory(item.model.name)
              );
              if (owner?.entrypoint === reference.entrypoint) {
                panel = item;
                break;
              }
            }
          }
          const reused = !!panel;
          const draft = panel?.model.input.value ?? '';
          const filepath: unknown = panel
            ? panel.model.name
            : await app.commands.execute('jupyterlab-chat:create', {
                path: projectDirectory(reference.entrypoint),
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
  }
};
