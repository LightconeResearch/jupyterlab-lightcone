import type { IChatPanel } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServerConnection } from '@jupyterlab/services';
import type { TranslationBundle } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

/** Sources narrower than this get a tab beside them rather than a split. */
const SPLIT_MIN_WIDTH = 1000;

/** Element tabs carry this id prefix (see `element-commands.ts`). */
const ELEMENT_TAB_PREFIX = 'lightcone-element-';

/**
 * Open files a session links to beside the session, so the conversation stays
 * where it is: the first file splits to the right, later ones join the group
 * that results already use, and an open file is revealed rather than reopened.
 */
export class BesideOpener {
  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly documents: IDocumentManager | null,
    private readonly labShell: ILabShell | null,
    private readonly trans: TranslationBundle
  ) {}

  /**
   * Open the Contents path `path`: files in a document tab beside `panel`,
   * folders in the file browser. A missing path is reported, never thrown.
   */
  async open(path: string, panel: IChatPanel | undefined): Promise<void> {
    let model: { type: string };
    try {
      model = await this.app.serviceManager.contents.get(path, {
        content: false
      });
    } catch (error) {
      if (
        error instanceof ServerConnection.ResponseError &&
        error.response.status === 404
      ) {
        Notification.warning(this.trans.__('No file at %1.', path || '/'), {
          autoClose: 4000
        });
        return;
      }
      throw error;
    }
    if (model.type === 'directory') {
      await this.app.commands.execute('filebrowser:go-to-path', { path });
      return;
    }
    const options = this.placement(panel);
    const opened: unknown = this.documents
      ? this.documents.openOrReveal(path, undefined, undefined, options)
      : await this.app.commands.execute('docmanager:open', {
          path,
          options: { ...options }
        });
    if (panel && opened instanceof Widget) {
      this._lastOpened.set(panel, opened);
    }
  }

  /** Where the next file from `panel` goes. */
  placement(panel: IChatPanel | undefined): DocumentRegistry.IOpenOptions {
    if (!panel || panel.area !== 'main' || panel.isDisposed) {
      return { activate: true };
    }
    const last = this._lastOpened.get(panel);
    if (last && !last.isDisposed) {
      return { mode: 'tab-after', ref: last.id, activate: true };
    }
    const group = this.resultGroupWidget(panel);
    if (group) {
      return { mode: 'tab-after', ref: group.id, activate: true };
    }
    return {
      mode:
        panel.node.clientWidth >= SPLIT_MIN_WIDTH ? 'split-right' : 'tab-after',
      ref: panel.id,
      activate: true
    };
  }

  /** A record tab living in another tab area than the session, when one exists. */
  private resultGroupWidget(panel: IChatPanel): Widget | undefined {
    if (!this.labShell) {
      return undefined;
    }
    const own = this.labShell.getMainAreaTabBar(panel);
    for (const widget of this.app.shell.widgets('main')) {
      if (
        widget.id.startsWith(ELEMENT_TAB_PREFIX) &&
        !widget.isDisposed &&
        this.labShell.getMainAreaTabBar(widget) !== own
      ) {
        return widget;
      }
    }
    return undefined;
  }

  private readonly _lastOpened = new WeakMap<IChatPanel, Widget>();
}
