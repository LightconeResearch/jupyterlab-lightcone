import type { IChatPanel } from '@jupyter/chat';
import { Notification } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { IDisposable } from '@lumino/disposable';
import { RENDERED_MESSAGE_SELECTOR } from './chat-dom';
import {
  isFileLink,
  resolveChatLink,
  rewriteImageSource,
  type IChatPathContext
} from './chat-paths';

/** How long the notice of a link that could not be opened stays, in ms. */
const OPEN_FAILURE_DURATION = 5000;

/** What the link fixer needs from its host. */
export interface IChatLinkHost {
  trans: TranslationBundle;
  /** Absolute filesystem paths naming the server root; empty when unknown. */
  serverRoots: readonly string[];
  /** The URL every `files/` route hangs off. */
  baseUrl: string;
  /** The Contents directory relative links in this chat resolve against. */
  baseDirectory(panel: IChatPanel): Promise<string>;
  /** Open a Contents path beside the chat. */
  open(path: string, panel: IChatPanel): Promise<void>;
}

/**
 * Make links and images in a chat work: agents write absolute server paths,
 * which browsers cannot follow. Clicks on such links open the file in
 * JupyterLab, and images are served through the `files/` route. Only message
 * bodies are rewritten; toolbars and avatars keep their links.
 */
export function attachChatLinks(
  panel: IChatPanel,
  host: IChatLinkHost
): IDisposable {
  let disposed = false;
  const context = async (): Promise<IChatPathContext> => ({
    serverRoots: host.serverRoots,
    baseDirectory: await host
      .baseDirectory(panel)
      .catch(() => PathExt.dirname(panel.model.name))
  });

  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest('a[href]');
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      !anchor.closest(RENDERED_MESSAGE_SELECTOR) ||
      !panel.node.contains(anchor)
    ) {
      return;
    }
    const reference = anchor.getAttribute('href') ?? '';
    // Decide synchronously from the link alone whether it is ours; the
    // browser must not navigate away while the project is being resolved.
    if (!isFileLink(reference, host.serverRoots)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void context()
      .then(async current => {
        const path = resolveChatLink(reference, current);
        if (path !== undefined && !disposed) {
          await host.open(path, panel);
        }
      })
      .catch(error => {
        console.error(`Could not open ${reference} from the chat.`, error);
        Notification.error(host.trans.__('Could not open %1.', reference), {
          autoClose: OPEN_FAILURE_DURATION
        });
      });
  };

  const rewrite = (image: HTMLImageElement, current: IChatPathContext) => {
    const source = image.getAttribute('src') ?? '';
    const url = rewriteImageSource(source, current, host.baseUrl);
    if (url && url !== source) {
      image.setAttribute('src', url);
    }
  };
  const collect = (node: Node, into: HTMLImageElement[]) => {
    if (!(node instanceof Element)) {
      return;
    }
    if (node instanceof HTMLImageElement) {
      into.push(node);
    }
    node.querySelectorAll('img[src]').forEach(image => {
      if (image instanceof HTMLImageElement) {
        into.push(image);
      }
    });
  };
  const fix = (nodes: Node[]) => {
    const images: HTMLImageElement[] = [];
    for (const node of nodes) {
      collect(node, images);
    }
    const inMessages = images.filter(
      image =>
        image.closest(RENDERED_MESSAGE_SELECTOR) &&
        isFileLink(image.getAttribute('src') ?? '', host.serverRoots)
    );
    if (!inMessages.length) {
      return;
    }
    void context()
      .then(current => {
        if (disposed) {
          return;
        }
        for (const image of inMessages) {
          rewrite(image, current);
        }
      })
      .catch(error => {
        console.error('Could not rewrite chat image sources.', error);
      });
  };

  const observer = new MutationObserver(records => {
    const nodes: Node[] = [];
    for (const record of records) {
      if (record.type === 'attributes') {
        nodes.push(record.target);
      } else {
        record.addedNodes.forEach(node => nodes.push(node));
      }
    }
    fix(nodes);
  });

  panel.node.addEventListener('click', onClick, true);
  observer.observe(panel.node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });
  fix([panel.node]);

  return {
    get isDisposed() {
      return disposed;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      observer.disconnect();
      panel.node.removeEventListener('click', onClick, true);
    }
  };
}
