import {
  IChatCommandRegistry,
  IChatTracker,
  IMessagePreambleRegistry,
  type IChatCommandProvider
} from '@jupyter/chat';
import {
  ILabShell,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import {
  EditorExtensionRegistry,
  IEditorExtensionRegistry
} from '@jupyterlab/codemirror';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { IChatProjectResolver } from '../chat-links/chat-project';
import { ICurrentProject } from '../current-project';
import { PALETTE_CATEGORY } from '../workbench-ids';
import { createCommentCards } from './comment-cards';
import { CommentHosts } from './comment-hosts';
import {
  commentIdsFromMetadata,
  METADATA_KEY,
  withCommentIds
} from './comment-model';
import { CommentPopover } from './comment-popover';
import { CommentService, ICommentService } from './comment-service';
import { commentDelivery, type CommentDelivery } from './comments-api';
import { ChatCommentTrays, type ICommentTrayActions } from './comment-tray';
import { editorCommentExtension } from './editor-comments';

export { ICommentService } from './comment-service';
export type {
  IComment,
  ICommentAnchor,
  ICommentDraft,
  ICommentPatch,
  ICommentTarget,
  CommentStatus
} from './comments-api';

export namespace CommentsCommandIDs {
  /** Open the target of a pending or sent comment: `{ entrypoint, id }`. */
  export const openCommentTarget = 'jupyterlab_lightcone:open-comment-target';
  /** Fetch a project's pending comments again: `{ entrypoint? }`. */
  export const refreshComments = 'jupyterlab_lightcone:refresh-comments';
}

/** Delay before the pending list is fetched again after a send, in ms. */
const POST_SEND_REFRESH = 1000;

/**
 * The chat command provider that sends pending comments: it stamps their
 * IDs into the outgoing message's metadata, where the server's persona
 * manager reads them, appends their text to the prompt and marks them sent.
 * Where the server runs another persona manager, which would ignore them,
 * it appends their block to the message text instead, visibly.
 */
export function commentCommandProvider(
  service: CommentService,
  projects: IChatProjectResolver,
  delivery: CommentDelivery = commentDelivery()
): IChatCommandProvider {
  return {
    id: 'jupyterlab_lightcone:comments',
    listCommandCompletions: async () => [],
    onSubmit: async input => {
      // The input keeps its metadata from one send to the next, so the IDs
      // stamped for an earlier message must not ride with this one.
      if (commentIdsFromMetadata(input.getMetadata()).length) {
        input.updateMetadata({
          [METADATA_KEY]: withCommentIds(input.getMetadata(), [])
        });
      }
      const name = input.chatContext?.name;
      if (!name) {
        return;
      }
      const entrypoint = (await projects.resolve(name))?.entrypoint;
      if (!entrypoint) {
        return;
      }
      if (!service.known(entrypoint)) {
        await service.refresh(entrypoint).catch(() => undefined);
      }
      const ids = service.pending(entrypoint).map(comment => comment.id);
      if (!ids.length) {
        return;
      }
      if (delivery === 'message') {
        const block = await service.send(entrypoint, ids, name);
        if (block) {
          input.value = input.value ? `${input.value}\n\n${block}` : block;
        }
      }
      input.updateMetadata({
        [METADATA_KEY]: withCommentIds(input.getMetadata(), ids)
      });
      window.setTimeout(() => {
        void service.refresh(entrypoint).catch(error => {
          console.warn('Could not refresh the pending comments.', error);
        });
      }, POST_SEND_REFRESH);
    }
  };
}

/**
 * Comments on figures, files and records: pins
 * and highlights where they were made, chips above the session's input,
 * sent with the next message and shown as cards on it.
 */
export const commentsPlugin: JupyterFrontEndPlugin<ICommentService> = {
  id: 'jupyterlab_lightcone:comments',
  description:
    'Comments on figures, files and records, sent with the next chat message.',
  autoStart: true,
  provides: ICommentService,
  requires: [ICurrentProject, IChatProjectResolver],
  optional: [
    IChatTracker,
    IChatCommandRegistry,
    IMessagePreambleRegistry,
    IEditorExtensionRegistry,
    IDocumentManager,
    ILabShell,
    ICommandPalette,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    projects: IChatProjectResolver,
    tracker: IChatTracker | null,
    chatCommands: IChatCommandRegistry | null,
    preambles: IMessagePreambleRegistry | null,
    editorExtensions: IEditorExtensionRegistry | null,
    documents: IDocumentManager | null,
    shell: ILabShell | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): ICommentService => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const service = new CommentService(app.serviceManager.serverSettings);
    const popover = new CommentPopover();
    const hosts = new CommentHosts({
      app,
      shell,
      documents,
      tracker,
      projects,
      service,
      popover
    });
    const open = (comment: Parameters<CommentHosts['openTarget']>[0]) => {
      void hosts.openTarget(comment).catch(reason => {
        void showErrorMessage(
          trans.__('Could not open the comment target'),
          reason instanceof Error ? reason : String(reason)
        );
      });
    };
    if (editorExtensions) {
      const extension = editorCommentExtension(hosts.editorHandlers);
      editorExtensions.addExtension({
        name: 'jupyterlab_lightcone:comment',
        factory: options =>
          options.inline
            ? null
            : EditorExtensionRegistry.createImmutableExtension(extension)
      });
    }
    const actions: ICommentTrayActions = {
      open,
      edit: (entrypoint, comment, element) =>
        hosts.editComment(entrypoint, comment, element),
      remove: (entrypoint, comment) => service.remove(entrypoint, comment.id)
    };
    let trays: ChatCommentTrays | null = null;
    if (tracker) {
      trays = new ChatCommentTrays(tracker, {
        service,
        projects,
        actions,
        chatPath: panel =>
          documents?.contextForWidget(panel)?.path ?? panel.model.name
      });
    }
    chatCommands?.addProvider(commentCommandProvider(service, projects));
    preambles?.addComponent(createCommentCards({ service, projects, open }));
    const refreshCurrent = () => {
      const entrypoint = current.project?.entrypoint;
      if (entrypoint) {
        void service.refresh(entrypoint).catch(error => {
          console.warn('Could not load the pending comments.', error);
        });
      }
    };
    current.changed.connect(refreshCurrent);
    refreshCurrent();
    app.commands.addCommand(CommentsCommandIDs.openCommentTarget, {
      label: trans.__('Open Comment Target'),
      caption: trans.__('Open what a Lightcone comment points at'),
      describedBy: {
        args: {
          type: 'object',
          required: ['entrypoint', 'id'],
          properties: { entrypoint: { type: 'string' }, id: { type: 'string' } }
        }
      },
      isEnabled: args => typeof args.id === 'string',
      execute: async args => {
        if (
          typeof args.entrypoint !== 'string' ||
          typeof args.id !== 'string'
        ) {
          throw new Error('An entrypoint and a comment id are required.');
        }
        const comment =
          service.pending(args.entrypoint).find(item => item.id === args.id) ??
          (await service.all(args.entrypoint)).find(
            item => item.id === args.id
          );
        if (!comment) {
          throw new Error('This comment no longer exists.');
        }
        await hosts.openTarget(comment);
      }
    });
    app.commands.addCommand(CommentsCommandIDs.refreshComments, {
      label: trans.__('Refresh Comments'),
      caption: trans.__('Fetch the pending Lightcone comments again'),
      describedBy: {
        args: {
          type: 'object',
          properties: { entrypoint: { type: 'string' } }
        }
      },
      isEnabled: args =>
        typeof args.entrypoint === 'string' || !!current.project,
      execute: args => {
        const entrypoint =
          typeof args.entrypoint === 'string'
            ? args.entrypoint
            : current.project?.entrypoint;
        if (!entrypoint) {
          throw new Error('No Lightcone project is open.');
        }
        return service.refresh(entrypoint);
      }
    });
    palette?.addItem({
      command: CommentsCommandIDs.refreshComments,
      category: PALETTE_CATEGORY
    });
    app.shell.disposed.connect(() => {
      current.changed.disconnect(refreshCurrent);
      trays?.dispose();
      hosts.dispose();
      popover.dispose();
      service.dispose();
    });
    return service;
  }
};
