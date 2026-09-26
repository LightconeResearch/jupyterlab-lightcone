import { getEditor, type IChatPanel, type IChatTracker } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, Notification } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { Contents, ServerConnection } from '@jupyterlab/services';
import type { EditorView } from '@codemirror/view';
import type { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import {
  CHAT_MESSAGE_SELECTOR,
  INPUT_CONTAINER_SELECTOR
} from '../chat-links/chat-dom';
import {
  recordedChatProject,
  type IChatProjectResolver
} from '../chat-links/chat-project';
import { CommandIDs } from '../commands';
import { ElementWidget } from '../element-widget';
import { projectDirectory } from '../project-data';
import { acquireProjectDataService } from '../project-data-service';
import { findProjectRoot } from '../project-root';
import { listVersions } from '../versions/versions-api';
import { CHAT_FACTORY } from '../workbench-ids';
import type { IComment, ICommentAnchor, ICommentTarget } from './comments-api';
import {
  NULL_VERSION,
  elementTarget,
  emptyAnchor,
  paperDoi,
  pointAnchor,
  sameTarget
} from './comment-model';
import { CommentPopover } from './comment-popover';
import type { CommentService } from './comment-service';
import {
  revealEditorComment,
  setEditorComments,
  type IEditorCommentHandlers
} from './editor-comments';
import { ImageCommentLayer } from './image-layer';
import {
  SelectionCommentButton,
  type ISelectionCapture
} from './selection-button';
import { TextCommentLayer } from './text-layer';

/** A main-area record tab. */
function isElementTab(widget: Widget): widget is MainAreaWidget<ElementWidget> {
  return (
    widget instanceof MainAreaWidget && widget.content instanceof ElementWidget
  );
}

/**
 * The committed version of an output record a comment is pinned to: the one
 * `shownCommit` names (a record tab showing an older version), else the
 * newest; nulls when there is none.
 */
export async function recordVersion(
  contents: Contents.IManager,
  settings: ServerConnection.ISettings,
  entrypoint: string,
  record: string,
  universeId: string | null | undefined,
  shownCommit?: string
): Promise<ICommentTarget['version']> {
  const lease = acquireProjectDataService(contents, entrypoint, universeId);
  try {
    const data = await lease.service.get();
    const resolved = data.index.recordByPath.get(record);
    if (!resolved || resolved.kind !== 'output') {
      return NULL_VERSION;
    }
    const listing = await listVersions(
      settings,
      entrypoint,
      data.document.universe.universeId,
      resolved.id
    );
    // The version the record tab shows, when it steps back; else the newest.
    const pinned =
      (shownCommit
        ? listing.versions.find(version =>
            version.commit.startsWith(shownCommit)
          )
        : undefined) ?? listing.versions[0];
    return pinned
      ? {
          commit: pinned.commit,
          key: pinned.annex?.key ?? null,
          hash: null,
          label: pinned.short
        }
      : NULL_VERSION;
  } catch (error) {
    console.warn('Could not pin the comment to an output version.', error);
    return NULL_VERSION;
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

  /** The node whose text the selection button offers to comment. */
  abstract get node(): HTMLElement;
  /** The project the comments belong to; null outside every project. */
  abstract get entrypoint(): string | null;
  /** What a new comment on this host points at, without a version. */
  abstract target(): ICommentTarget | null;
  /** The version a new comment is pinned to. */
  abstract version(): Promise<ICommentTarget['version']>;

  image: ImageCommentLayer | null = null;
  text: TextCommentLayer | null = null;
  view: EditorView | null = null;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * What a comment on a selection points at. A host is one target, except a
   * session, whose messages are each their own.
   */
  targetFor(_root: HTMLElement): ICommentTarget | null {
    return this.target();
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
    this.text?.setComments(comments);
    this.view?.dispatch({ effects: setEditorComments.of(comments) });
    this.revealEditorFlash();
  }

  /**
   * Scroll to a comment's pin or badge and flash it. The layers remember the
   * request until the pin exists; an editor's badges exist only once its
   * project, its pending comments and its text are known, so the host keeps
   * the request and tries again on each refresh until then.
   */
  flash(id: string): void {
    this.image?.flash(id);
    this.text?.flash(id);
    this._editorFlash = id;
    this.revealEditorFlash();
  }

  /**
   * Whether this host shows every editor badge it is going to show, so that
   * a comment it cannot reveal now will not appear later. Hosts without an
   * editor are always settled.
   */
  protected get settled(): boolean {
    return true;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.image?.dispose();
    this.text?.dispose();
    this.image = null;
    this.text = null;
    this.view = null;
  }

  /** Reveal the comment the editor was asked to flash; give up once settled. */
  private revealEditorFlash(): void {
    const id = this._editorFlash;
    if (id === null) {
      return;
    }
    const revealed = !!this.view && revealEditorComment(this.view, id);
    if (revealed || this.settled) {
      this._editorFlash = null;
    }
  }

  private _editorFlash: string | null = null;
  private _isDisposed = false;
}

/** A record tab: pins on its figure, badges in its text and PDF pages. */
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
    this.text = new TextCommentLayer({
      host: node,
      onBadgeClick: (comment, element) =>
        hosts.showComment(this, comment, element)
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
    if (!target?.record || paperDoi(target.record)) {
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

/** How a document widget carries comments. */
export type FileHostKind = 'image' | 'text' | 'editor';

/** A document: an image, a Markdown preview or a text editor. */
class FileHost extends CommentHost {
  constructor(
    widget: Widget,
    private context: DocumentRegistry.Context,
    hosts: CommentHosts,
    private kind: FileHostKind,
    view: EditorView | null
  ) {
    super(widget, hosts);
    this._node =
      widget instanceof MainAreaWidget ? widget.content.node : widget.node;
    if (kind === 'image') {
      this.image = new ImageCommentLayer({
        host: this._node,
        selectImages: () => Array.from(this._node.querySelectorAll('img')),
        onPoint: (image, x, y, event) =>
          hosts.startPointComment(this, image, x, y, event),
        onPinClick: (comment, element) =>
          hosts.showComment(this, comment, element),
        onPinMoved: (comment, x, y) => hosts.moveComment(this, comment, x, y)
      });
    } else if (kind === 'text') {
      this.text = new TextCommentLayer({
        host: this._node,
        onBadgeClick: (comment, element) =>
          hosts.showComment(this, comment, element)
      });
    }
    this.view = view;
    context.pathChanged.connect(this._pathChanged, this);
    // Hosts are made while the document loads. An editor builds its badges
    // when comments arrive, and comments that arrive before its text find
    // nothing to mark: push them again once the text is there.
    void context.ready.then(() => this.refresh());
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
      message: null,
      version: NULL_VERSION
    };
  }

  async version(): Promise<ICommentTarget['version']> {
    return { ...NULL_VERSION, hash: this.context.contentsModel?.hash ?? null };
  }

  /**
   * An editor is settled once it is attached, its text is loaded, its project
   * is known and that project's pending comments were fetched.
   */
  protected get settled(): boolean {
    if (this.kind !== 'editor') {
      return true;
    }
    const entrypoint = this._entrypoint;
    return (
      !!this.view &&
      this.context.isReady &&
      this._resolved &&
      (entrypoint === null || this.hosts.service.known(entrypoint))
    );
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
    this._resolved = true;
    this.refresh();
  }

  private _pathChanged(): void {
    this._entrypoint = null;
    this._resolved = false;
    void this.resolve();
  }

  private _node: HTMLElement;
  private _entrypoint: string | null = null;
  private _resolved = false;
}

/**
 * A session in the main area: selections in its messages are commented,
 * each comment pointing at its message, and its badges mark the quotes.
 */
class SessionHost extends CommentHost {
  constructor(
    private panel: IChatPanel,
    hosts: CommentHosts
  ) {
    super(panel, hosts);
    this.text = new TextCommentLayer({
      host: panel.widget.node,
      onBadgeClick: (comment, element) =>
        hosts.showComment(this, comment, element)
    });
    void this.resolve();
  }

  get node(): HTMLElement {
    return this.panel.widget.node;
  }

  get entrypoint(): string | null {
    return this._entrypoint;
  }

  /** The chat file, as the comment store names a session. */
  get path(): string {
    return (
      this.hosts.documents?.contextForWidget(this.panel)?.path ??
      this.panel.model.name
    );
  }

  /** No single target: each message is its own. */
  target(): ICommentTarget | null {
    return null;
  }

  targetFor(root: HTMLElement): ICommentTarget | null {
    const index = Number.parseInt(root.dataset.index ?? '', 10);
    const message = Number.isInteger(index)
      ? this.panel.model.messages[index]
      : undefined;
    if (!message) {
      return null;
    }
    return {
      kind: 'message',
      path: this.path,
      record: null,
      universe: null,
      message: message.id,
      version: NULL_VERSION
    };
  }

  async version(): Promise<ICommentTarget['version']> {
    return NULL_VERSION;
  }

  /** Every pending comment on one of this session's messages. */
  comments(): readonly IComment[] {
    const entrypoint = this.entrypoint;
    if (!entrypoint) {
      return [];
    }
    const path = this.path;
    return this.hosts.service
      .pending(entrypoint)
      .filter(
        comment =>
          comment.target.kind === 'message' && comment.target.path === path
      );
  }

  private async resolve(): Promise<void> {
    const project = await this.hosts.projects.resolve(
      this.path,
      recordedChatProject(this.panel.model)
    );
    if (this.isDisposed) {
      return;
    }
    this._entrypoint = project?.entrypoint ?? null;
    this.refresh();
  }

  private _entrypoint: string | null = null;
}

export interface ICommentHostsOptions {
  app: JupyterFrontEnd;
  shell: ILabShell | null;
  documents: IDocumentManager | null;
  /** Jupyter Chat's panel tracker, whose main-area panels are sessions; null without Jupyter Chat. */
  tracker: IChatTracker | null;
  /** Files a session under its project. */
  projects: IChatProjectResolver;
  service: CommentService;
  popover: CommentPopover;
}

/**
 * Where comments are made and shown: record tabs, sessions, image documents,
 * Markdown previews and file editors in the main area. It attaches a layer to
 * each, feeds them the pending comments of their project, and opens the
 * popover.
 */
export class CommentHosts implements IDisposable {
  constructor(private options: ICommentHostsOptions) {
    const { app, shell, service, tracker } = options;
    this.selection = new SelectionCommentButton<CommentHost>({
      resolve: node => this.resolveSelection(node),
      onComment: capture => this.startTextComment(capture)
    });
    service.changed.connect(this._serviceChanged, this);
    shell?.layoutModified.connect(this.scan, this);
    app.shell.currentChanged?.connect(this.scan, this);
    void app.restored.then(() => this.scan());
    tracker?.forEach(panel => this.attachSession(panel));
    tracker?.widgetAdded.connect(this._onChatAdded, this);
    const register = (factory: string, kind: FileHostKind) => {
      this._extensions.push(
        app.docRegistry.addWidgetExtension(factory, {
          createNew: (widget, context) => {
            if (this._isDisposed) {
              return;
            }
            // The file editor's CodeMirror view exists once the widget does.
            const view =
              kind === 'editor' ? (getEditor(widget)?.editor ?? null) : null;
            this.attachFile(widget, context, kind, view);
          }
        })
      );
    };
    register('Image', 'image');
    register('Markdown Preview', 'text');
    register('Editor', 'editor');
  }

  /** The Contents manager, for project lookups. */
  get contents(): Contents.IManager {
    return this.options.app.serviceManager.contents;
  }

  /** The server settings, for the versions API. */
  get settings(): ServerConnection.ISettings {
    return this.options.app.serviceManager.serverSettings;
  }

  /** The document manager, for the paths of open documents. */
  get documents(): IDocumentManager | null {
    return this.options.documents;
  }

  /** The resolver filing sessions under their project. */
  get projects(): IChatProjectResolver {
    return this.options.projects;
  }

  get service(): CommentService {
    return this.options.service;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** What the CodeMirror extension calls. */
  readonly editorHandlers: IEditorCommentHandlers = {
    onComment: (view, anchor) => this.startEditorComment(view, anchor),
    onBadge: (view, comment, element) => {
      const host = this.hostForView(view);
      if (host) {
        this.showComment(host, comment, element);
      }
    }
  };

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
      const doi = paperDoi(target.record);
      const result: unknown = await app.commands.execute(
        CommandIDs.openElement,
        {
          entrypoint: target.path,
          target: doi ? '' : (target.record ?? ''),
          ...(doi ? { doi } : {}),
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
        path: target.path,
        ...(target.kind === 'message' ? { factory: CHAT_FACTORY } : {})
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
    const { app, shell, service, tracker } = this.options;
    service.changed.disconnect(this._serviceChanged, this);
    shell?.layoutModified.disconnect(this.scan, this);
    app.shell.currentChanged?.disconnect(this.scan, this);
    tracker?.widgetAdded.disconnect(this._onChatAdded, this);
    this.selection.dispose();
    for (const extension of this._extensions) {
      extension.dispose();
    }
    this._extensions.length = 0;
    for (const host of this._hosts.values()) {
      host.dispose();
    }
    this._hosts.clear();
  }

  /** Comment the transcript of a chat the tracker knows, when it is a session. */
  private attachSession(panel: IChatPanel): void {
    if (
      this._isDisposed ||
      panel.isDisposed ||
      panel.area !== 'main' ||
      this._hosts.has(panel)
    ) {
      return;
    }
    this.register(panel, new SessionHost(panel, this));
  }

  private _onChatAdded(_tracker: IChatTracker, panel: IChatPanel): void {
    this.attachSession(panel);
  }

  private attachFile(
    widget: Widget,
    context: DocumentRegistry.Context,
    kind: FileHostKind,
    view: EditorView | null
  ): void {
    if (this._hosts.has(widget)) {
      return;
    }
    this.register(widget, new FileHost(widget, context, this, kind, view));
  }

  private register(widget: Widget, host: CommentHost): void {
    this._hosts.set(widget, host);
    widget.disposed.connect(() => {
      host.dispose();
      this._hosts.delete(widget);
    });
    host.refresh();
  }

  private hostForView(view: EditorView): CommentHost | undefined {
    for (const host of this._hosts.values()) {
      if (host.view === view) {
        return host;
      }
    }
    return undefined;
  }

  private hostById(id: string): CommentHost | undefined {
    for (const [widget, host] of this._hosts) {
      if (widget.id === id) {
        return host;
      }
    }
    return undefined;
  }

  /**
   * The host a selection lies in, and the element whose text gives the quote
   * its context. Host nodes never nest, so containment names the host; a
   * selection inside one message of a session comments on that message, and
   * one in a CodeMirror editor is the editor extension's business.
   */
  private resolveSelection(
    node: Node
  ): { host: CommentHost; root: HTMLElement } | null {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || element.closest('.cm-editor')) {
      return null;
    }
    const message = element.closest<HTMLElement>(CHAT_MESSAGE_SELECTOR);
    if (message) {
      if (element.closest(INPUT_CONTAINER_SELECTOR)) {
        return null;
      }
      for (const host of this._hosts.values()) {
        if (
          host instanceof SessionHost &&
          host.entrypoint &&
          host.node.contains(message)
        ) {
          return { host, root: message };
        }
      }
      return null;
    }
    this.scan();
    for (const host of this._hosts.values()) {
      if (
        !(host instanceof SessionHost) &&
        host.text &&
        host.entrypoint &&
        host.node.contains(element)
      ) {
        return { host, root: host.node };
      }
    }
    return null;
  }

  private startTextComment(capture: ISelectionCapture<CommentHost>): void {
    const { host } = capture;
    const entrypoint = host.entrypoint;
    const target = host.targetFor(capture.root);
    if (!entrypoint || !target) {
      this.noProject();
      return;
    }
    const anchor: ICommentAnchor = {
      ...emptyAnchor(capture.page !== null ? 'pdf' : 'text'),
      quote: capture.quote,
      prefix: capture.prefix,
      page: capture.page
    };
    this.options.popover.open({
      x: capture.x,
      y: capture.y,
      mode: 'compose',
      onSave: async text => {
        const version = await host.version();
        await this.service.add(entrypoint, {
          text,
          target: { ...target, version },
          anchor
        });
      }
    });
  }

  private startEditorComment(view: EditorView, anchor: ICommentAnchor): void {
    const host = this.hostForView(view);
    const entrypoint = host?.entrypoint;
    const target = host?.target();
    if (!host || !entrypoint || !target) {
      this.noProject();
      return;
    }
    const coords = view.coordsAtPos(view.state.selection.main.head);
    const fallback = view.dom.getBoundingClientRect();
    this.options.popover.open({
      x: coords?.left ?? fallback.left + 24,
      y: (coords?.bottom ?? fallback.top) + 8,
      mode: 'compose',
      onSave: async text => {
        const version = await host.version();
        await this.service.add(entrypoint, {
          text,
          target: { ...target, version },
          anchor
        });
      }
    });
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

  private selection: SelectionCommentButton<CommentHost>;
  private _hosts = new Map<Widget, CommentHost>();
  private _extensions: IDisposable[] = [];
  private _isDisposed = false;
}
