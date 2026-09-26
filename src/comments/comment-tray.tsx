import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import { PathExt } from '@jupyterlab/coreutils';
import {
  closeIcon,
  editIcon,
  imageIcon,
  pdfIcon,
  textEditorIcon,
  type LabIcon
} from '@jupyterlab/ui-components';
import type { IDisposable } from '@lumino/disposable';
import React, { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstraKindMark } from '../astra-kind';
import { inputContainerSelector } from '../chat-links/chat-dom';
import type { IChatProjectResolver } from '../chat-links/chat-project';
import type { IComment } from './comments-api';
import type { CommentService, ICommentService } from './comment-service';
import {
  chipText,
  chipTooltip,
  commentKind,
  labelGlyph,
  targetKind,
  type CommentKind
} from './comment-model';

/** The icon of a comment's anchor, for comments on files and messages. */
function kindIcon(kind: CommentKind): LabIcon {
  switch (kind) {
    case 'image':
      return imageIcon;
    case 'pdf':
      return pdfIcon;
    default:
      return textEditorIcon;
  }
}

/**
 * What a comment is on, as an icon: the ASTRA kind mark of a record, as the
 * inventory draws it, else the icon of the file or message anchor. The mark
 * takes `<base>-kind` and the icon `<base>-icon`.
 */
export function CommentTargetIcon({
  comment,
  base
}: {
  comment: Pick<IComment, 'anchor' | 'target'>;
  base: string;
}): React.ReactElement {
  const kind = targetKind(comment.target);
  if (kind) {
    return <AstraKindMark kind={kind} className={`${base}-kind`} />;
  }
  const Icon = kindIcon(commentKind(comment));
  return <Icon.react tag="span" className={`${base}-icon`} />;
}

/** Keep a component in step with a project's pending comments. */
export function usePending(
  service: ICommentService,
  entrypoint: string | null
): readonly IComment[] {
  const [comments, setComments] = useState<readonly IComment[]>(() =>
    entrypoint ? service.pending(entrypoint) : []
  );
  useEffect(() => {
    if (!entrypoint) {
      setComments([]);
      return;
    }
    const key = PathExt.normalize(entrypoint);
    const update = (_sender: ICommentService, changed: string) => {
      if (changed === key) {
        setComments(service.pending(key));
      }
    };
    service.changed.connect(update);
    setComments(service.pending(key));
    return () => {
      service.changed.disconnect(update);
    };
  }, [service, entrypoint]);
  return comments;
}

/** What chips do. */
export interface ICommentTrayActions {
  /** Open the comment's target and scroll to its pin. */
  open(comment: IComment): void;
  /** Edit the comment's text, near the chip. */
  edit(entrypoint: string, comment: IComment, element: HTMLElement): void;
  /** Delete the comment. */
  remove(entrypoint: string, comment: IComment): Promise<void>;
}

interface IChipProps {
  entrypoint: string;
  comment: IComment;
  actions: ICommentTrayActions;
}

function CommentChip({
  entrypoint,
  comment,
  actions
}: IChipProps): React.ReactElement {
  return (
    <div
      className="jp-jupyterlab-lightcone-CommentChip"
      role="listitem"
      data-kind={commentKind(comment)}
      title={chipTooltip(comment)}
    >
      <button
        type="button"
        className="jp-jupyterlab-lightcone-CommentChip-open"
        onClick={event => {
          // Jupyter Chat focuses its input on a click that leaves the focus
          // outside the chat, which would take the opened target's tab back.
          event.stopPropagation();
          actions.open(comment);
        }}
      >
        <CommentTargetIcon
          comment={comment}
          base="jp-jupyterlab-lightcone-CommentChip"
        />
        <span className="jp-jupyterlab-lightcone-CommentChip-label">
          {labelGlyph(comment.label)}
        </span>
        <span className="jp-jupyterlab-lightcone-CommentChip-text">
          {chipText(comment)}
        </span>
      </button>
      <button
        type="button"
        className="jp-jupyterlab-lightcone-CommentChip-action"
        aria-label="Edit comment"
        title="Edit"
        onClick={event =>
          actions.edit(entrypoint, comment, event.currentTarget)
        }
      >
        <editIcon.react tag="span" />
      </button>
      <button
        type="button"
        className="jp-jupyterlab-lightcone-CommentChip-action"
        aria-label="Delete comment"
        title="Delete"
        onClick={() => {
          void actions.remove(entrypoint, comment).catch(error => {
            console.warn('Could not delete the comment.', error);
          });
        }}
      >
        <closeIcon.react tag="span" />
      </button>
    </div>
  );
}

export interface ICommentTrayProps {
  service: ICommentService;
  entrypoint: string;
  actions: ICommentTrayActions;
}

/** The pending comments of a project as chips, above a session's input. */
export function CommentTray({
  service,
  entrypoint,
  actions
}: ICommentTrayProps): React.ReactElement | null {
  const comments = usePending(service, entrypoint);
  if (!comments.length) {
    return null;
  }
  return (
    <div
      className="jp-jupyterlab-lightcone-CommentTray"
      role="list"
      aria-label="Pending comments"
    >
      {comments.map(comment => (
        <CommentChip
          key={comment.id}
          entrypoint={entrypoint}
          comment={comment}
          actions={actions}
        />
      ))}
    </div>
  );
}

/** What the tray mounts need from the plugin. */
export interface IChatTrayDependencies {
  service: CommentService;
  /** Files a chat under its project. */
  projects: IChatProjectResolver;
  actions: ICommentTrayActions;
  /** The Contents path of a chat panel's file. */
  chatPath(panel: IChatPanel): string;
}

/** Delay between a message update and the pending list's refresh, in ms. */
const REFRESH_DELAY = 1000;

/**
 * One tray per main-area chat. Jupyter Chat has no input-header hook, so the
 * tray's node is placed just before the chat's input container and put back
 * whenever React re-renders around it.
 */
class TrayMount implements IDisposable {
  constructor(
    private panel: IChatPanel,
    private deps: IChatTrayDependencies
  ) {
    this._host = document.createElement('div');
    this._host.className = 'jp-jupyterlab-lightcone-CommentTrayHost';
    this._root = createRoot(this._host);
    void deps.projects.resolve(deps.chatPath(panel)).then(project => {
      const entrypoint = project?.entrypoint;
      if (this._isDisposed || !entrypoint) {
        return;
      }
      this._entrypoint = entrypoint;
      this._root.render(
        <CommentTray
          service={deps.service}
          entrypoint={entrypoint}
          actions={deps.actions}
        />
      );
      this.place();
      this._observer = new MutationObserver(() => this.place());
      this._observer.observe(panel.widget.node, {
        childList: true,
        subtree: true
      });
      panel.model.messagesUpdated.connect(this._messages, this);
      void deps.service.refresh(entrypoint).catch(error => {
        console.warn('Could not load the pending comments.', error);
      });
    });
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    window.clearTimeout(this._timer);
    this._observer?.disconnect();
    this.panel.model.messagesUpdated.disconnect(this._messages, this);
    this._root.unmount();
    this._host.remove();
  }

  /** Put the tray right before the chat's own input, if it is rendered. */
  private place(): void {
    const input = this.panel.widget.node.querySelector<HTMLElement>(
      inputContainerSelector(this.panel.model.input.id)
    );
    if (!input || !input.parentElement) {
      return;
    }
    if (this._host.nextElementSibling !== input) {
      input.parentElement.insertBefore(this._host, input);
    }
  }

  private _messages = (): void => {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => {
      if (this._entrypoint) {
        void this.deps.service.refresh(this._entrypoint).catch(error => {
          console.warn('Could not refresh the pending comments.', error);
        });
      }
    }, REFRESH_DELAY);
  };

  private _host: HTMLElement;
  private _root: Root;
  private _entrypoint: string | null = null;
  private _observer: MutationObserver | null = null;
  private _timer = 0;
  private _isDisposed = false;
}

/** Trays for every main-area chat the tracker knows, now and later. */
export class ChatCommentTrays implements IDisposable {
  constructor(
    private tracker: IChatTracker,
    private deps: IChatTrayDependencies
  ) {
    tracker.widgetAdded.connect(this._added, this);
    tracker.forEach(panel => this.mount(panel));
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.tracker.widgetAdded.disconnect(this._added, this);
    for (const mount of this._mounts.values()) {
      mount.dispose();
    }
    this._mounts.clear();
  }

  private mount(panel: IChatPanel): void {
    if (panel.isDisposed || panel.area !== 'main' || this._mounts.has(panel)) {
      return;
    }
    const mount = new TrayMount(panel, this.deps);
    this._mounts.set(panel, mount);
    panel.disposed.connect(() => {
      mount.dispose();
      this._mounts.delete(panel);
    });
  }

  private _added = (_sender: IChatTracker, panel: IChatPanel): void => {
    this.mount(panel);
  };

  private _mounts = new Map<IChatPanel, TrayMount>();
  private _isDisposed = false;
}
