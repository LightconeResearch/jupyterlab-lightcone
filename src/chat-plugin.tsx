import React, { useEffect, useState } from 'react';
import {
  chatIcon,
  IChatCommandRegistry,
  IChatTracker,
  type IChatPanel
} from '@jupyter/chat';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { CommandIDs } from './commands';
import { ServerConnection } from '@jupyterlab/services';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import {
  chatContexts,
  chatContextProvider,
  contextForChat,
  type IChatContext
} from './chat-context';
import { acquireProjectDataService } from './project-data-service';
import { parseElementReference } from './element-reference';
import { projectEntrypoint } from './project-root';
import { projectDirectory } from './project-data';
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
    ITranslator,
    IChatCommandRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: IChatTracker | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
    translator: ITranslator | null,
    chatCommands: IChatCommandRegistry | null
  ) => {
    if (!tracker || !chatCommands) return;
    chatCommands.addProvider(chatContextProvider);
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const watch = async (panel: IChatPanel) => {
      const model = panel.model;
      const id = await model.ready;
      if (panel.isDisposed) return;
      const update = () => {
        try {
          const context = contextForChat(model);
          if (context) {
            chatContexts.set(id, context);
            // Input metadata is copied onto each prompt, including after reloading a saved chat.
            if (
              JSON.stringify(model.input.getMetadata().lightcone) !==
              JSON.stringify(context)
            )
              model.input.updateMetadata({ lightcone: context });
          } else chatContexts.delete(id);
        } catch {
          chatContexts.delete(id);
        }
      };
      update();
      model.messagesUpdated.connect(update);
      model.messageChanged.connect(update);
      model.input.metadataChanged?.connect(update);
      panel.disposed.connect(() => {
        model.messagesUpdated.disconnect(update);
        model.messageChanged.disconnect(update);
        model.input.metadataChanged?.disconnect(update);
        const remaining = tracker.find(
          item => item !== panel && !item.isDisposed && item.model.id === id
        );
        try {
          const context = remaining
            ? contextForChat(remaining.model)
            : undefined;
          if (context) chatContexts.set(id, context);
          else chatContexts.delete(id);
        } catch {
          chatContexts.delete(id);
        }
      });
      panel.widget.inputToolbarRegistry?.addItem('lightcone-context', {
        position: 1,
        element: function ContextChip() {
          const [, render] = useState(0);
          useEffect(() => {
            const changed = () => render(value => value + 1);
            model.input.metadataChanged?.connect(changed);
            model.messagesUpdated.connect(changed);
            return () => {
              model.input.metadataChanged?.disconnect(changed);
              model.messagesUpdated.disconnect(changed);
            };
          }, []);
          let context: IChatContext | undefined;
          let error: string | undefined;
          try {
            context = contextForChat(model);
          } catch (reason) {
            error = String(reason);
          }

          return (
            <button
              type="button"
              className="jp-jupyterlab-lightcone-chat-context"
              title={
                context
                  ? `${context.entrypoint} · ${context.universeId ?? 'defaults'}`
                  : 'Start a discussion from an ASTRA project'
              }
              onClick={() => {
                void app.commands
                  .execute(
                    context ? CommandIDs.openInventory : CommandIDs.discuss,
                    context ? { path: context.entrypoint } : {}
                  )
                  .catch(reason =>
                    showErrorMessage('Could not open ASTRA discussion', reason)
                  );
              }}
            >
              {context
                ? `✦ ${projectDirectory(context.entrypoint) || 'ASTRA'} · ${context.universeId ?? 'defaults'}`
                : (error ?? trans.__('Lightcone Agent'))}
            </button>
          );
        }
      });
    };
    tracker.widgetAdded.connect((_sender, panel) => {
      void watch(panel).catch(reason =>
        console.warn('Could not attach Lightcone chat context.', reason)
      );
    });
    tracker.forEach(panel => {
      void watch(panel).catch(reason =>
        console.warn('Could not attach Lightcone chat context.', reason)
      );
    });
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
            target: { type: 'string' },
            universeId: { type: ['string', 'null'] }
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
                ? await projectEntrypoint(app.serviceManager.contents, args.cwd)
                : current instanceof InventoryDocument
                  ? current.context.path
                  : await projectEntrypoint(
                      app.serviceManager.contents,
                      browser?.tracker.currentWidget?.model.path ?? ''
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
              await app.commands.execute(CommandIDs.createProject, {
                path: projectDirectory(reference.entrypoint)
              });
              return null;
            }
            throw error;
          }
          const lease = acquireProjectDataService(
            app.serviceManager.contents,
            entrypoint,
            reference.universeId
          );
          try {
            const data = await lease.service.get();
            if (lease.service.state.error)
              throw new Error(lease.service.state.error);
            const context: IChatContext = {
              version: 1,
              entrypoint: reference.entrypoint,
              universeId:
                data.document.universe.source === 'none'
                  ? null
                  : data.document.universe.universeId
            };
            // Adding a record reuses only a chat with the exact same pinned context.
            let panel =
              reference.target || reference.doi
                ? tracker.find(item => {
                    try {
                      const bound = contextForChat(item.model);
                      return (
                        bound?.entrypoint === context.entrypoint &&
                        bound.universeId === context.universeId
                      );
                    } catch {
                      return false;
                    }
                  })
                : undefined;
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
            panel.model.input.updateMetadata({ lightcone: context });
            chatContexts.set(id, context);
            if (reference.target || reference.doi)
              panel.model.input.value = `${draft}${draft ? '\n\n' : ''}Discuss ASTRA element ${reference.doi ? `DOI ${reference.doi}` : reference.target}.`;
            panel.model.input.focus();
            return { ...context, chatId: id, reused };
          } finally {
            lease.release();
          }
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
