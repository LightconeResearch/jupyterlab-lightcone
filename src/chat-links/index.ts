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
import { projectDirectory } from '../project-data';
import { serverRoots } from './chat-paths';
import { IChatProjectResolver } from './chat-project';
import { attachChatLinks } from './link-fixer';
import { BesideOpener } from './open-beside';
import { ResultsHistoryCache } from './results-cache';
import { createTurnResultsFooter } from './turn-results-footer';

export {
  IChatProjectResolver,
  createChatProjectResolver
} from './chat-project';

/**
 * Working links and turn results in sessions: file links and images an agent
 * writes as server paths open in JupyterLab, and the last message of a reply
 * lists results and files changed while the agent answered. Uses the shared
 * project resolver supplied by the session layer.
 */
export const chatLinksPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:chat-links',
  description:
    'Open file links from Lightcone sessions in JupyterLab and list results changed during each reply.',
  autoStart: true,
  requires: [IDocumentManager, IChatProjectResolver],
  optional: [IChatTracker, IMessageFooterRegistry, ILabShell, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    documents: IDocumentManager,
    projects: IChatProjectResolver,
    tracker: IChatTracker | null,
    footers: IMessageFooterRegistry | null,
    labShell: ILabShell | null,
    translator: ITranslator | null
  ) => {
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
            const project = await projects.resolve(chatPath);
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
          results,
          resolveProject: chatPath => projects.resolve(chatPath),
          openFile
        })
      });
    }
  }
};
