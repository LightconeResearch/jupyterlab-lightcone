import React, { useEffect, useState } from 'react';
import {
  chatIcon,
  IChatCommandRegistry,
  IChatTracker,
  IAttachmentOpenerRegistry,
  type IChatPanel
} from '@jupyter/chat';
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
import {
  chatContexts,
  chatContextProvider,
  contextForChat,
  type IChatContext
} from './chat-context';
import { acquireProjectDataService } from './project-data-service';
import { parseElementReference } from './element-reference';
import { InventoryDocument } from './document-widget';
import {
  elementSnapshot,
  saveElementAttachment,
  isElementAttachment,
  readElementAttachment,
  validateElementAttachments
} from './element-attachment';

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
    ITranslator,
    IChatCommandRegistry,
    IAttachmentOpenerRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: IChatTracker | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null,
    launcher: ILauncher | null,
    translator: ITranslator | null,
    chatCommands: IChatCommandRegistry | null,
    attachmentOpeners: IAttachmentOpenerRegistry | null
  ) => {
    if (!tracker || !chatCommands) return;
    chatCommands.addProvider({
      ...chatContextProvider,
      onSubmit: async input => {
        const bound = contextForChat({
          messages: (input.chatContext?.messages ?? []).map(content => ({
            content
          })),
          input
        });
        await validateElementAttachments(
          app.serviceManager.contents,
          input.attachments,
          bound
        );
        await chatContextProvider.onSubmit(input);
      }
    });
    const openFile = attachmentOpeners?.get('file');
    attachmentOpeners?.set('file', attachment => {
      if (!isElementAttachment(attachment)) {
        openFile?.(attachment);
        return;
      }
      void readElementAttachment(app.serviceManager.contents, attachment)
        .then(snapshot =>
          app.commands.execute(CommandIDs.openElement, {
            ...snapshot.reference
          })
        )
        .catch(reason =>
          showErrorMessage('Could not open attached ASTRA element', reason)
        );
    });
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
                ? `✦ ${PathExt.dirname(context.entrypoint) || 'ASTRA'} · ${context.universeId ?? 'defaults'}`
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
            const snapshot =
              reference.target || reference.doi
                ? elementSnapshot(data, reference)
                : undefined;
            // Adding a record reuses only a chat with the exact same pinned context.
            const matches = (item: IChatPanel) => {
              if (item.isDisposed) return false;
              try {
                const bound = contextForChat(item.model);
                return (
                  bound?.entrypoint === context.entrypoint &&
                  bound.universeId === context.universeId
                );
              } catch {
                return false;
              }
            };
            let panel = snapshot
              ? tracker.currentWidget && matches(tracker.currentWidget)
                ? tracker.currentWidget
                : tracker.find(matches)
              : undefined;
            const reused = !!panel;
            if (panel?.area === 'main') {
              app.shell.activateById(panel.id);
            } else {
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
            }
            if (!panel)
              throw new Error(
                'The chat did not open. Check that Jupyter AI is enabled.'
              );
            const id = await panel.model.ready;
            panel.model.input.updateMetadata({ lightcone: context });
            chatContexts.set(id, context);
            if (snapshot) {
              const addAttachment = panel.model.input.addAttachment;
              if (!addAttachment)
                throw new Error('This chat does not support attachments.');
              const attachment = await saveElementAttachment(
                app.serviceManager.contents,
                snapshot
              );
              addAttachment.call(panel.model.input, attachment);
            }
            const destination = panel;
            // Let the originating inventory dialog close before moving focus.
            requestAnimationFrame(() => {
              if (!destination.isDisposed) destination.model.input.focus();
            });
            return {
              ...context,
              chatId: id,
              chatPath: panel.model.name,
              reused
            };
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
    launcher?.add({
      command: CommandIDs.discuss,
      category: 'Lightcone Lab',
      categoryRank: -10,
      rank: 0
    });
  }
};
