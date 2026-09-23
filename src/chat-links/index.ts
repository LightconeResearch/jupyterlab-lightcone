import {
  IChatTracker,
  IMessageFooterRegistry,
  type IChatPanel
} from '@jupyter/chat';
import {
  ILabShell,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ICurrentProject } from '../current-project';
import { projectDirectory } from '../project-data';
import { serverRoots } from './chat-paths';
import { createChatProjectResolver, recordedChatProject } from './chat-project';
import { attachChatLinks } from './link-fixer';
import { BesideOpener } from './open-beside';
import { createTurnResultsFooter } from './turn-results-footer';

/**
 * Working links and turn results in sessions: file links and images an agent
 * writes as server paths open in JupyterLab, and the last message of a reply
 * lists what was materialized and edited while the agent answered.
 */
export const chatLinksPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat-links',
  description:
    'Open file links from Lightcone sessions in JupyterLab and list what each reply materialized.',
  autoStart: true,
  optional: [
    IChatTracker,
    IDocumentManager,
    IMessageFooterRegistry,
    ICurrentProject,
    ILabShell,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: IChatTracker | null,
    documents: IDocumentManager | null,
    footers: IMessageFooterRegistry | null,
    currentProject: ICurrentProject | null,
    labShell: ILabShell | null,
    translator: ITranslator | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const contents = app.serviceManager.contents;
    // `lightconeServerRoot` is published by this extension's server side,
    // `rootUri` by jupyter-lsp and `serverRoot` by JupyterLab.
    const roots = serverRoots({
      lightconeServerRoot: PageConfig.getOption('lightconeServerRoot'),
      rootUri: PageConfig.getOption('rootUri'),
      serverRoot: PageConfig.getOption('serverRoot')
    });
    const opener = new BesideOpener(app, documents, labShell, trans);
    const projects = createChatProjectResolver(
      contents,
      () => currentProject?.project
    );
    const openFile = (path: string, panel: IChatPanel | undefined) =>
      opener.open(path, panel);

    if (tracker) {
      const attach = (panel: IChatPanel) => {
        if (panel.isDisposed) {
          return;
        }
        const links = attachChatLinks(panel, {
          serverRoots: roots,
          baseUrl: app.serviceManager.serverSettings.baseUrl,
          baseDirectory: async chat => {
            const chatPath = chat.model.name;
            const project = await projects.resolve(
              chatPath,
              recordedChatProject(chat.model)
            );
            return project
              ? contents.localPath(project.path)
              : contents.localPath(projectDirectory(chatPath));
          },
          open: openFile
        });
        panel.disposed.connect(() => links.dispose());
      };
      tracker.forEach(attach);
      tracker.widgetAdded.connect((_sender, panel) => attach(panel));
    }

    if (footers) {
      footers.addSection({
        position: 'left',
        component: createTurnResultsFooter({
          app,
          tracker,
          trans,
          serverRoots: roots,
          resolveProject: (chatPath, recorded) =>
            projects.resolve(chatPath, recorded),
          openFile
        })
      });
    }
  }
};
