import { ReactWidget } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import React, { useEffect, useRef, useState } from 'react';
import { COMMENT_COUNTER_THRESHOLD, COMMENT_TEXT_LIMIT } from './comment-model';

/** What a popover shows and does. */
export interface IPopoverRequest {
  /** Viewport coordinates the popover opens near. */
  x: number;
  y: number;
  /** `compose` edits text; `view` shows a saved comment with Edit and Delete. */
  mode: 'compose' | 'view';
  /** The comment's current text; empty for a new comment. */
  text?: string;
  /** Save the text; rejections are shown and keep the popover open. */
  onSave(text: string): Promise<void>;
  /** Delete the comment; only offered in `view` mode when present. */
  onDelete?(): Promise<void>;
  /** The popover closed without saving. */
  onCancel?(): void;
}

interface IBodyProps {
  request: IPopoverRequest;
  close(): void;
}

function PopoverBody({ request, close }: IBodyProps): React.ReactElement {
  const [mode, setMode] = useState(request.mode);
  const [text, setText] = useState(request.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (mode === 'compose') {
      const node = area.current;
      node?.focus();
      node?.setSelectionRange(node.value.length, node.value.length);
    }
  }, [mode]);
  const trimmed = text.trim();
  const save = async () => {
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.onSave(trimmed.slice(0, COMMENT_TEXT_LIMIT));
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!request.onDelete || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.onDelete();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  const cancel = () => {
    request.onCancel?.();
    close();
  };
  if (mode === 'view') {
    return (
      <div
        className="jp-jupyterlab-lightcone-CommentPopover-body"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <p className="jp-jupyterlab-lightcone-CommentPopover-text">
          {request.text}
        </p>
        {error && (
          <p
            className="jp-jupyterlab-lightcone-CommentPopover-error"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="jp-jupyterlab-lightcone-CommentPopover-actions">
          {request.onDelete && (
            <button
              type="button"
              className="jp-Button jp-mod-minimal"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
          <button
            type="button"
            className="jp-Button jp-mod-accept"
            disabled={busy}
            autoFocus
            onClick={() => setMode('compose')}
          >
            Edit
          </button>
        </div>
      </div>
    );
  }
  const remaining = COMMENT_TEXT_LIMIT - text.length;
  return (
    <div className="jp-jupyterlab-lightcone-CommentPopover-body">
      <textarea
        ref={area}
        className="jp-jupyterlab-lightcone-CommentPopover-input"
        placeholder="Add a comment…"
        aria-label="Comment"
        rows={3}
        maxLength={COMMENT_TEXT_LIMIT}
        value={text}
        disabled={busy}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      />
      {remaining <= COMMENT_COUNTER_THRESHOLD && (
        <span className="jp-jupyterlab-lightcone-CommentPopover-counter">
          {text.length} / {COMMENT_TEXT_LIMIT}
        </span>
      )}
      {error && (
        <p
          className="jp-jupyterlab-lightcone-CommentPopover-error"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="jp-jupyterlab-lightcone-CommentPopover-actions">
        <button
          type="button"
          className="jp-Button jp-mod-minimal"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-accept"
          disabled={busy || !trimmed}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** Width the popover is laid out with, to keep it inside the viewport. */
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 160;

/**
 * The single comment popover: "Add a comment…" with Cancel and Save, or a
 * saved comment with Edit and Delete. It floats over the page near the pin
 * or selection and closes on Escape, Cancel or a click elsewhere.
 */
export class CommentPopover extends ReactWidget {
  constructor() {
    super();
    this.addClass('jp-jupyterlab-lightcone-CommentPopover');
    this.addClass('jp-ThemedContainer');
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-label', 'Comment');
  }

  /** Whether a popover is showing. */
  get isOpen(): boolean {
    return this._request !== null;
  }

  /** Show the popover for a request, closing any previous one. */
  open(request: IPopoverRequest): void {
    if (this._request) {
      this._request.onCancel?.();
    }
    this._request = request;
    this._key += 1;
    const left = Math.max(
      8,
      Math.min(window.innerWidth - POPOVER_WIDTH - 8, request.x)
    );
    const top = Math.max(
      8,
      Math.min(window.innerHeight - POPOVER_HEIGHT - 8, request.y)
    );
    this.node.style.left = `${left}px`;
    this.node.style.top = `${top}px`;
    if (!this.isAttached) {
      Widget.attach(this, document.body);
      document.addEventListener('pointerdown', this._outside, true);
    }
    this.update();
  }

  /** Hide the popover without calling back. */
  close(): void {
    if (!this._request) {
      return;
    }
    this._request = null;
    if (this.isAttached) {
      document.removeEventListener('pointerdown', this._outside, true);
      Widget.detach(this);
    }
    this.update();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._request?.onCancel?.();
    this.close();
    super.dispose();
  }

  render(): React.ReactElement | null {
    const request = this._request;
    if (!request) {
      return null;
    }
    return (
      <PopoverBody
        key={this._key}
        request={request}
        close={() => {
          if (this._request === request) {
            this.close();
          }
        }}
      />
    );
  }

  private _outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.node.contains(event.target)) {
      return;
    }
    const request = this._request;
    this.close();
    request?.onCancel?.();
  };

  private _request: IPopoverRequest | null = null;
  private _key = 0;
}
