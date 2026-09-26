import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICurrentProject } from '../current-project';
import {
  createChatProjectResolver,
  IChatProjectResolver
} from './chat-project';

/** Share chat/project binding independently of chat decorations. */
export const chatProjectPlugin: JupyterFrontEndPlugin<IChatProjectResolver> = {
  id: 'jupyterlab_lightcone:chat-project',
  description: 'Resolve chats to their owning or recorded Lightcone project.',
  autoStart: true,
  provides: IChatProjectResolver,
  optional: [ICurrentProject],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject | null
  ): IChatProjectResolver =>
    createChatProjectResolver(
      app.serviceManager.contents,
      () => current?.project
    )
};
