import React, { useEffect, useState } from 'react';
import {
  IChatTracker,
  IMessagePreambleRegistry,
  type IChatPanel
} from '@jupyter/chat';
import {
  MainAreaWidget,
  IThemeManager,
  ICommandPalette,
  showErrorMessage
} from '@jupyterlab/apputils';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { PathExt } from '@jupyterlab/coreutils';
import { recordTitle } from '@astra-spec/ui/model';
import { CommandIDs } from './commands';
import {
  chatContexts,
  contextForChat,
  contextualArguments,
  type IChatContext
} from './chat-context';
import { ChatPreview } from './chat-preview';
import { acquireProjectDataService } from './project-data-service';
import { parseElementReference } from './element-reference';
import { ElementWidget } from './element-widget';
import { InventoryDocument } from './document-widget';

/** Optional integration with Jupyter AI's chat UI; inventory and record tabs work independently. */
export const chatPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat',
  description: 'ASTRA references and agent navigation in Jupyter AI chats.',
  autoStart: true,
  requires: [IThemeManager],
  optional: [
    IChatTracker,
    IMessagePreambleRegistry,
    ICommandPalette,
    IFileBrowserFactory
  ],
  activate: (
    app: JupyterFrontEnd,
    themes: IThemeManager,
    tracker: IChatTracker | null,
    preambles: IMessagePreambleRegistry | null,
    palette: ICommandPalette | null,
    browser: IFileBrowserFactory | null
  ) => {
    if (!tracker || !preambles) return;
    preambles.addComponent(props => (
      <ChatPreview {...props} app={app} themes={themes} />
    ));
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
                : (error ?? 'Discuss ASTRA project')}
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
      label: 'Discuss ASTRA project',
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
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
            let panel = reference.target
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
            if (!panel) {
              const widget: unknown = await app.commands.execute(
                'jupyterlab-chat:createAndOpen',
                { path: PathExt.dirname(entrypoint), inSidePanel: false }
              );
              panel = tracker.find(item => item === widget);
            }
            if (!panel)
              throw new Error(
                'The chat did not open. Check that Jupyter AI is enabled.'
              );
            const id = await panel.model.ready;
            panel.model.input.updateMetadata({ lightcone: context });
            chatContexts.set(id, context);
            if (reused) {
              panel.model.input.value += `${panel.model.input.value ? '\n\n' : ''}Discuss {astra}\`${reference.target}\`.`;
            } else
              panel.model.input.value = `Discuss the ASTRA project ${entrypoint}${reference.target ? `, especially {astra}\`${reference.target}\`` : ''}. Use lightcone_project_context to inspect its real targets, cite them with {astra} roles, and use lightcone_open_element when helpful.`;
            app.shell.activateById(panel.id);
            panel.model.input.focus();
            return { ...context, chatId: id, reused };
          } finally {
            lease.release();
          }
        } catch (reason) {
          await showErrorMessage('Could not start ASTRA discussion', reason);
          return null;
        }
      }
    });
    app.commands.addCommand(CommandIDs.projectContext, {
      label: 'Read ASTRA project context',
      describedBy: {
        args: {
          type: 'object',
          properties: {
            entrypoint: { type: 'string' },
            universeId: { type: ['string', 'null'] },
            query: { type: 'string' },
            offset: { type: 'integer', minimum: 0 }
          }
        }
      },
      execute: async args => {
        const contextual = contextualArguments(args);
        const reference = parseElementReference({ ...contextual, target: '' });
        const lease = acquireProjectDataService(
          app.serviceManager.contents,
          reference.entrypoint,
          reference.universeId
        );
        try {
          const data = await lease.service.get();
          if (lease.service.state.error)
            throw new Error(lease.service.state.error);
          const query =
            typeof args.query === 'string'
              ? args.query.toLowerCase().slice(0, 200)
              : '';
          const offset =
            typeof args.offset === 'number' &&
            Number.isSafeInteger(args.offset) &&
            args.offset >= 0
              ? args.offset
              : 0;
          const records = [...data.index.recordByPath.values()]
            .map(record => ({
              target: record.canonicalPath,
              kind: record.kind,
              label: recordTitle(record).slice(0, 240)
            }))
            .filter(record =>
              `${record.target} ${record.label}`.toLowerCase().includes(query)
            );
          const active = app.shell.currentWidget;
          const activeReference =
            active instanceof MainAreaWidget &&
            active.content instanceof ElementWidget
              ? active.content.reference
              : undefined;
          return {
            capabilities: [
              'record-previews',
              'record-tabs',
              'cited-paper-tabs',
              'read-element'
            ],
            activeElement:
              activeReference?.entrypoint === reference.entrypoint
                ? { ...activeReference }
                : null,
            entrypoint: reference.entrypoint,
            universeId:
              data.document.universe.source === 'none'
                ? null
                : data.document.universe.universeId,
            syntax:
              '{astra}`outputs.figure` or {astra}`the figure <outputs.figure>`. Targets are rooted at this project. Open records with lightcone_open_element. Child option/evidence targets open their owning record.',
            records: records.slice(offset, offset + 50),
            nextOffset: offset + 50 < records.length ? offset + 50 : null
          };
        } finally {
          lease.release();
        }
      }
    });
    palette?.addItem({
      command: CommandIDs.discuss,
      category: 'Lightcone Lab'
    });
  }
};
