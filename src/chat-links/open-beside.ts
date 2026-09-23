import type { IChatPanel } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServerConnection } from '@jupyterlab/services';
import type { TranslationBundle } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

/** Element tabs carry this id prefix (see `element-commands.ts`). */
const ELEMENT_TAB_PREFIX = 'lightcone-element-';

/**
 * Open files a session links to beside the session, so the conversation stays
 * where it is: the first file splits to the right, however narrow the session
 * (as results do in `element-tabs.ts`), later ones join the group that files
 * or results already use, and an open file is revealed rather than reopened.
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

  /**
   * Where the next file from `panel` goes: after the last file it opened, else
   * after a record tab, else split to its right. A tab is never added to the
   * session's own tab area, where it would cover the conversation.
   */
  placement(panel: IChatPanel | undefined): DocumentRegistry.IOpenOptions {
    if (!panel || panel.area !== 'main' || panel.isDisposed) {
      return { activate: true };
    }
    const last = this._lastOpened.get(panel);
    if (last && !last.isDisposed && this.besideSession(panel, last)) {
      return { mode: 'tab-after', ref: last.id, activate: true };
    }
    const group = this.resultGroupWidget(panel);
    if (group) {
      return { mode: 'tab-after', ref: group.id, activate: true };
    }
    return { mode: 'split-right', ref: panel.id, activate: true };
  }

  /** Whether `widget` lives in another main-area tab area than `panel`. */
  private besideSession(panel: IChatPanel, widget: Widget): boolean {
    return (
      !this.labShell ||
      this.labShell.getMainAreaTabBar(widget) !==
        this.labShell.getMainAreaTabBar(panel)
    );
  }

  /** A record tab living in another tab area than the session, when one exists. */
  private resultGroupWidget(panel: IChatPanel): Widget | undefined {
    if (!this.labShell) {
      return undefined;
    }
    for (const widget of this.app.shell.widgets('main')) {
      if (
        widget.id.startsWith(ELEMENT_TAB_PREFIX) &&
        !widget.isDisposed &&
        this.besideSession(panel, widget)
      ) {
        return widget;
      }
    }
    return undefined;
  }

  private readonly _lastOpened = new WeakMap<IChatPanel, Widget>();
}
