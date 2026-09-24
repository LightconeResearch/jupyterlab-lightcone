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
import {
  createChatProjectResolver,
  IChatProjectResolver,
  recordedChatProject
} from './chat-project';
import { attachChatLinks } from './link-fixer';
import { BesideOpener } from './open-beside';
import { ResultsHistoryCache } from './results-cache';
import { createTurnResultsFooter } from './turn-results-footer';

export {
  IChatProjectResolver,
  recordedChatProject,
  createChatProjectResolver
} from './chat-project';

/**
 * Working links and turn results in sessions: file links and images an agent
 * writes as server paths open in JupyterLab, and the last message of a reply
 * lists what was materialized and edited while the agent answered. Provides
 * the resolver that files a chat under its project, which comments, mentions
 * and the agent continuity share.
 */
export const chatLinksPlugin: JupyterFrontEndPlugin<IChatProjectResolver> = {
  id: 'jupyterlab_lightcone:chat-links',
  description:
    'Open file links from Lightcone sessions in JupyterLab and list what each reply materialized.',
  autoStart: true,
  provides: IChatProjectResolver,
  requires: [IDocumentManager],
  optional: [
    IChatTracker,
    IMessageFooterRegistry,
    ICurrentProject,
    ILabShell,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    documents: IDocumentManager,
    tracker: IChatTracker | null,
    footers: IMessageFooterRegistry | null,
    currentProject: ICurrentProject | null,
    labShell: ILabShell | null,
    translator: ITranslator | null
  ): IChatProjectResolver => {
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
    const results = new ResultsHistoryCache(app.serviceManager.serverSettings);
    app.shell.disposed.connect(() => results.dispose());
    const openFile = (path: string, panel: IChatPanel | undefined) =>
      opener.open(path, panel);

    if (tracker) {
      const attach = (panel: IChatPanel) => {
        if (panel.isDisposed) {
          return;
        }
        const links = attachChatLinks(panel, {
          trans,
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
          documents,
          tracker,
          trans,
          serverRoots: roots,
          results,
          resolveProject: (chatPath, recorded) =>
            projects.resolve(chatPath, recorded),
          openFile
        })
      });
    }
    return projects;
  }
};
