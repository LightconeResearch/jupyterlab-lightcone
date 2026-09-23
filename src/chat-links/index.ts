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
import { normalizeServerRoot } from './chat-paths';
import { createChatProjectResolver } from './chat-project';
import { attachChatLinks } from './link-fixer';
import { BesideOpener } from './open-beside';
import { createTurnResultsFooter } from './turn-results-footer';

export { isFileLink, resolveChatLink, rewriteImageSource } from './chat-paths';
export {
  filesEditedIn,
  isAgentMessage,
  materializedDuring,
  turnEndingAt
} from './turn-results';

/**
 * The server's root directory as an absolute filesystem path. The ACP client
 * publishes `rootUri` on some deployments; JupyterLab always sets `serverRoot`.
 */
export function serverRootPath(): string {
  const rootUri = PageConfig.getOption('rootUri');
  if (rootUri) {
    try {
      const url = new URL(rootUri);
      if (url.protocol === 'file:') {
        return normalizeServerRoot(decodeURIComponent(url.pathname));
      }
    } catch {
      // Fall through to the plain server root below.
    }
  }
  return normalizeServerRoot(PageConfig.getOption('serverRoot'));
}

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
    const serverRoot = serverRootPath();
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
          serverRoot,
          baseUrl: app.serviceManager.serverSettings.baseUrl,
          baseDirectory: async chatPath => {
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
          serverRoot,
          resolveProject: chatPath => projects.resolve(chatPath),
          openFile
        })
      });
    }
  }
};
