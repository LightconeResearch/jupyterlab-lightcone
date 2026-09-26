import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, Notification } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { Contents, ServerConnection } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import { CommandIDs } from '../commands';
import { ElementWidget } from '../element-widget';
import { isRootAnalysisOutput } from '../materialization-status';
import { projectDirectory } from '../project-data';
import { acquireProjectDataService } from '../project-data-service';
import { findProjectRoot } from '../project-root';
import { listVersions } from '../versions/versions-api';
import type { IComment, ICommentTarget } from './comments-api';
import {
  NULL_VERSION,
  elementTarget,
  pointAnchor,
  sameTarget
} from './comment-model';
import { CommentPopover } from './comment-popover';
import type { CommentService } from './comment-service';
import { ImageCommentLayer } from './image-layer';
/** A main-area record tab. */
function isElementTab(widget: Widget): widget is MainAreaWidget<ElementWidget> {
  return (
    widget instanceof MainAreaWidget && widget.content instanceof ElementWidget
  );
}

/**
 * The committed version of an output record a comment is pinned to: the one
 * `shownCommit` names (a record tab showing an older version), else the
 * newest. An explicit commit stays pinned even when its metadata cannot be
 * read; nulls when there is neither a selection nor a committed version.
 */
export async function recordVersion(
  contents: Contents.IManager,
  settings: ServerConnection.ISettings,
  entrypoint: string,
  record: string,
  universeId: string | null | undefined,
  shownCommit?: string
): Promise<ICommentTarget['version']> {
  const fallback = shownCommit
    ? { ...NULL_VERSION, commit: shownCommit, label: shownCommit.slice(0, 7) }
    : NULL_VERSION;
  const lease = acquireProjectDataService(contents, entrypoint, universeId);
  try {
    const data = await lease.service.get();
    const resolved = data.index.recordByPath.get(record);
    if (
      !resolved ||
      resolved.kind !== 'output' ||
      !isRootAnalysisOutput(data.index, resolved)
    ) {
      return NULL_VERSION;
    }
    const listing = await listVersions(
      settings,
      entrypoint,
      data.document.universe.universeId,
      resolved.id
    );
    // The version the record tab shows, when it steps back; else the newest.
    const pinned = shownCommit
      ? listing.versions.find(version => version.commit.startsWith(shownCommit))
      : listing.versions[0];
    return pinned
      ? {
          commit: pinned.commit,
          key: pinned.annex?.key ?? null,
          hash: null,
          label: pinned.short
        }
      : fallback;
  } catch (error) {
    console.warn('Could not pin the comment to an output version.', error);
    return fallback;
  } finally {
    lease.release();
  }
}

/** A widget whose content can carry comments. */
abstract class CommentHost implements IDisposable {
  constructor(
    readonly widget: Widget,
    protected hosts: CommentHosts
  ) {}

  /** The node containing the image and its comment pins. */
  abstract get node(): HTMLElement;
  /** The project the comments belong to; null outside every project. */
  abstract get entrypoint(): string | null;
  /** What a new comment on this host points at, without a version. */
  abstract target(): ICommentTarget | null;
  /** The version a new comment is pinned to. */
  abstract version(): Promise<ICommentTarget['version']>;

  image: ImageCommentLayer | null = null;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** The pending comments of this host's target. */
  comments(): readonly IComment[] {
    const target = this.target();
    const entrypoint = this.entrypoint;
    if (!target || !entrypoint) {
      return [];
    }
    return this.hosts.service
      .pending(entrypoint)
      .filter(comment => sameTarget(comment.target, target));
  }

  /** Push the current pending comments into every layer. */
  refresh(): void {
    if (this._isDisposed) {
      return;
    }
    const comments = this.comments();
    this.image?.setComments(comments);
  }

  /** Scroll to a comment's pin and flash it once the image has loaded. */
  flash(id: string): void {
    this.image?.flash(id);
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.image?.dispose();
    this.image = null;
  }

  private _isDisposed = false;
}

/** A record tab carrying pins on its output figure. */
class ElementHost extends CommentHost {
  constructor(tab: MainAreaWidget<ElementWidget>, hosts: CommentHosts) {
    super(tab, hosts);
    this.element = tab.content;
    const node = this.element.node;
    this.image = new ImageCommentLayer({
      host: node,
      selectImages: () =>
        Array.from(
          node.querySelectorAll<HTMLImageElement>(
            '.astra-output-detail__artifact img'
          )
        ),
      onPoint: (image, x, y, event) =>
        hosts.startPointComment(this, image, x, y, event),
      onPinClick: (comment, element) =>
        hosts.showComment(this, comment, element),
      onPinMoved: (comment, x, y) => hosts.moveComment(this, comment, x, y)
    });
    this.element.title.changed.connect(this._changed, this);
  }

  get node(): HTMLElement {
    return this.element.node;
  }

  get entrypoint(): string {
    return this.element.reference.entrypoint;
  }

  target(): ICommentTarget | null {
    return elementTarget(this.element);
  }

  async version(): Promise<ICommentTarget['version']> {
    const target = this.target();
    if (!target?.record) {
      return NULL_VERSION;
    }
    return recordVersion(
      this.hosts.contents,
      this.hosts.settings,
      target.path,
      target.record,
      this.element.reference.universeId,
      this.element.selectedVersion
    );
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.element.title.changed.disconnect(this._changed, this);
    super.dispose();
  }

  private _changed(): void {
    this.refresh();
  }

  private element: ElementWidget;
}

/** An image document carrying pins. */
class FileHost extends CommentHost {
  constructor(
    widget: Widget,
    private context: DocumentRegistry.Context,
    hosts: CommentHosts
  ) {
    super(widget, hosts);
    this._node =
      widget instanceof MainAreaWidget ? widget.content.node : widget.node;
    this.image = new ImageCommentLayer({
      host: this._node,
      selectImages: () => Array.from(this._node.querySelectorAll('img')),
      onPoint: (image, x, y, event) =>
        hosts.startPointComment(this, image, x, y, event),
      onPinClick: (comment, element) =>
        hosts.showComment(this, comment, element),
      onPinMoved: (comment, x, y) => hosts.moveComment(this, comment, x, y)
    });
    context.pathChanged.connect(this._pathChanged, this);
    void this.resolve();
  }

  get node(): HTMLElement {
    return this._node;
  }

  get entrypoint(): string | null {
    return this._entrypoint;
  }

  target(): ICommentTarget {
    return {
      kind: 'file',
      path: this.context.path,
      record: null,
      universe: null,
      version: NULL_VERSION
    };
  }

  async version(): Promise<ICommentTarget['version']> {
    return { ...NULL_VERSION, hash: this.context.contentsModel?.hash ?? null };
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.context.pathChanged.disconnect(this._pathChanged, this);
    super.dispose();
  }

  private async resolve(): Promise<void> {
    const path = this.context.path;
    let entrypoint: string | null = null;
    try {
      // The document's folder, keeping its Contents drive.
      const root = await findProjectRoot(
        this.hosts.contents,
        projectDirectory(path)
      );
      entrypoint = root?.entrypoint ?? null;
    } catch (error) {
      console.warn('Could not find the project owning a document.', error);
    }
    if (this.isDisposed || this.context.path !== path) {
      return;
    }
    this._entrypoint = entrypoint;
    this.refresh();
  }

  private _pathChanged(): void {
    this._entrypoint = null;
    void this.resolve();
  }

  private _node: HTMLElement;
  private _entrypoint: string | null = null;
}

export interface ICommentHostsOptions {
  app: JupyterFrontEnd;
  shell: ILabShell | null;
  service: CommentService;
  popover: CommentPopover;
}

/**
 * Where comments are made and shown: record tabs and image documents in the main area. It attaches a layer to
 * each, feeds them the pending comments of their project, and opens the
 * popover.
 */
export class CommentHosts implements IDisposable {
  constructor(private options: ICommentHostsOptions) {
    const { app, shell, service } = options;
    service.changed.connect(this._serviceChanged, this);
    shell?.layoutModified.connect(this.scan, this);
    app.shell.currentChanged?.connect(this.scan, this);
    void app.restored.then(() => this.scan());
    this._extensions.push(
      app.docRegistry.addWidgetExtension('Image', {
        createNew: (widget, context) => {
          if (!this._isDisposed) this.attachFile(widget, context);
        }
      })
    );
  }

  /** The Contents manager, for project lookups. */
  get contents(): Contents.IManager {
    return this.options.app.serviceManager.contents;
  }

  /** The server settings, for the versions API. */
  get settings(): ServerConnection.ISettings {
    return this.options.app.serviceManager.serverSettings;
  }

  get service(): CommentService {
    return this.options.service;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Attach a host to every record tab the shell shows. */
  scan = (): void => {
    if (this._isDisposed) {
      return;
    }
    for (const widget of this.options.app.shell.widgets('main')) {
      if (!this._hosts.has(widget) && isElementTab(widget)) {
        this.register(widget, new ElementHost(widget, this));
      }
    }
  };

  /** Open a comment's target where it belongs and flash its pin. */
  async openTarget(comment: IComment): Promise<void> {
    const { app } = this.options;
    const { target } = comment;
    let host: CommentHost | undefined;
    if (target.kind === 'record') {
      const result: unknown = await app.commands.execute(
        CommandIDs.openElement,
        {
          entrypoint: target.path,
          target: target.record ?? '',
          ...(target.version.commit
            ? { versionCommit: target.version.commit }
            : {}),
          universeId: target.universe
        }
      );
      this.scan();
      const widgetId =
        isRecord(result) && typeof result.widgetId === 'string'
          ? result.widgetId
          : undefined;
      host = widgetId ? this.hostById(widgetId) : undefined;
    } else {
      const opened: unknown = await app.commands.execute('docmanager:open', {
        path: target.path
      });
      if (opened instanceof Widget) {
        app.shell.activateById(opened.id);
        host = this._hosts.get(opened);
      }
    }
    host?.flash(comment.id);
  }

  /** Edit a comment's text from a chip. */
  editComment(
    entrypoint: string,
    comment: IComment,
    element: HTMLElement
  ): void {
    const rect = element.getBoundingClientRect();
    this.options.popover.open({
      x: rect.left,
      y: rect.bottom + 6,
      mode: 'compose',
      text: comment.text,
      onSave: async text => {
        await this.service.update(entrypoint, comment.id, { text });
      }
    });
  }

  /** Show a saved comment near its pin, with Edit and Delete. */
  showComment(
    host: CommentHost,
    comment: IComment,
    element: HTMLElement
  ): void {
    const entrypoint = host.entrypoint;
    if (!entrypoint) {
      return;
    }
    const rect = element.getBoundingClientRect();
    this.options.popover.open({
      x: rect.left,
      y: rect.bottom + 6,
      mode: 'view',
      text: comment.text,
      onSave: async text => {
        await this.service.update(entrypoint, comment.id, { text });
      },
      onDelete: async () => {
        await this.service.remove(entrypoint, comment.id);
      }
    });
  }

  /** Save a dragged pin's new place. */
  moveComment(
    host: CommentHost,
    comment: IComment,
    x: number,
    y: number
  ): void {
    const entrypoint = host.entrypoint;
    if (!entrypoint) {
      return;
    }
    void this.service
      .update(entrypoint, comment.id, {
        anchor: { ...comment.anchor, x, y }
      })
      .catch(error => {
        console.warn('Could not move the comment.', error);
        host.refresh();
      });
  }

  /** A click on an image: drop a draft marker and open the popover. */
  startPointComment(
    host: CommentHost,
    image: HTMLImageElement,
    x: number,
    y: number,
    event: MouseEvent
  ): void {
    const entrypoint = host.entrypoint;
    const target = host.target();
    if (!entrypoint || !target) {
      this.noProject();
      return;
    }
    host.image?.setDraft(image, x, y);
    this.options.popover.open({
      x: event.clientX + 12,
      y: event.clientY + 12,
      mode: 'compose',
      onSave: async text => {
        const version = await host.version();
        await this.service.add(entrypoint, {
          text,
          target: { ...target, version },
          anchor: pointAnchor(x, y)
        });
        host.image?.setDraft(null);
      },
      onCancel: () => host.image?.setDraft(null)
    });
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    const { app, shell, service } = this.options;
    service.changed.disconnect(this._serviceChanged, this);
    shell?.layoutModified.disconnect(this.scan, this);
    app.shell.currentChanged?.disconnect(this.scan, this);
    for (const extension of this._extensions) {
      extension.dispose();
    }
    this._extensions.length = 0;
    for (const host of this._hosts.values()) {
      host.dispose();
    }
    this._hosts.clear();
  }

  private attachFile(widget: Widget, context: DocumentRegistry.Context): void {
    if (this._hosts.has(widget)) {
      return;
    }
    this.register(widget, new FileHost(widget, context, this));
  }

  private register(widget: Widget, host: CommentHost): void {
    this._hosts.set(widget, host);
    widget.disposed.connect(() => {
      host.dispose();
      this._hosts.delete(widget);
    });
    host.refresh();
  }

  private hostById(id: string): CommentHost | undefined {
    for (const [widget, host] of this._hosts) {
      if (widget.id === id) {
        return host;
      }
    }
    return undefined;
  }

  private noProject(): void {
    Notification.warning(
      'Comments belong to a Lightcone project; this document is outside every project.',
      { autoClose: 5000 }
    );
  }

  private _serviceChanged(_sender: unknown, entrypoint: string): void {
    const key = PathExt.normalize(entrypoint);
    for (const host of this._hosts.values()) {
      if (host.entrypoint && PathExt.normalize(host.entrypoint) === key) {
        host.refresh();
      }
    }
  }

  private _hosts = new Map<Widget, CommentHost>();
  private _extensions: IDisposable[] = [];
  private _isDisposed = false;
}
