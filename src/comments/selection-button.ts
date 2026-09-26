import type { IDisposable } from '@lumino/disposable';
import { PAGE_ATTRIBUTE, PREFIX_LIMIT, QUOTE_LIMIT } from './comment-model';

/** A text selection inside a commentable rendered view. */
export interface ISelectionCapture<T> {
  /** What the host resolver returned for the selection's container. */
  host: T;
  /** The element whose text the quote and prefix are taken from. */
  root: HTMLElement;
  quote: string;
  prefix: string | null;
  /** 1-based PDF page holding the selection start, when inside one. */
  page: number | null;
  /** Where the button was, for placing the popover. */
  x: number;
  y: number;
}

export interface ISelectionButtonOptions<T> {
  /**
   * The commentable view containing a node, with the element whose text
   * gives the quote its context; null when the node is not commentable.
   */
  resolve(node: Node): { host: T; root: HTMLElement } | null;
  /** The user pressed Comment. */
  onComment(capture: ISelectionCapture<T>): void;
}

/** Delay after a selection change before the button moves, in ms. */
const SETTLE_DELAY = 120;

/**
 * A floating Comment button that follows non-empty text selections inside
 * commentable rendered views: record tabs, Markdown previews and PDF pages.
 */
export class SelectionCommentButton<T> implements IDisposable {
  constructor(private options: ISelectionButtonOptions<T>) {
    this._button = document.createElement('button');
    this._button.type = 'button';
    this._button.className = 'jp-jupyterlab-lightcone-CommentButton';
    this._button.dataset.floating = '';
    this._button.textContent = 'Comment';
    this._button.hidden = true;
    this._button.addEventListener('mousedown', event => {
      // Keep the selection while the popover opens.
      event.preventDefault();
    });
    this._button.addEventListener('click', this._commented);
    document.body.appendChild(this._button);
    document.addEventListener('selectionchange', this._changed);
    document.addEventListener('scroll', this._hide, true);
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
    document.removeEventListener('selectionchange', this._changed);
    document.removeEventListener('scroll', this._hide, true);
    this._button.remove();
  }

  private _changed = (): void => {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(this._settle, SETTLE_DELAY);
  };

  private _hide = (): void => {
    this._button.hidden = true;
    this._capture = null;
  };

  private _settle = (): void => {
    if (this._isDisposed) {
      return;
    }
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this._hide();
      return;
    }
    const range = selection.getRangeAt(0);
    const quote = selection.toString().trim();
    if (!quote) {
      this._hide();
      return;
    }
    const resolved = this.options.resolve(range.commonAncestorContainer);
    if (!resolved || !resolved.root.contains(range.commonAncestorContainer)) {
      this._hide();
      return;
    }
    const rects = Array.from(range.getClientRects()).filter(
      rect => rect.width > 0 || rect.height > 0
    );
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const before = document.createRange();
    before.setStart(resolved.root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const prefix = before.toString().slice(-PREFIX_LIMIT);
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const pageValue = startElement
      ?.closest(`[${PAGE_ATTRIBUTE}]`)
      ?.getAttribute(PAGE_ATTRIBUTE);
    const page = pageValue ? Number.parseInt(pageValue, 10) : Number.NaN;
    const x = Math.min(window.innerWidth - 96, last.right + 6);
    const y = Math.min(window.innerHeight - 40, last.bottom + 6);
    this._capture = {
      host: resolved.host,
      root: resolved.root,
      quote: quote.slice(0, QUOTE_LIMIT),
      prefix: prefix.length ? prefix : null,
      page: Number.isInteger(page) && page > 0 ? page : null,
      x,
      y
    };
    this._button.style.left = `${x}px`;
    this._button.style.top = `${y}px`;
    this._button.hidden = false;
  };

  private _commented = (event: MouseEvent): void => {
    event.preventDefault();
    const capture = this._capture;
    this._hide();
    if (capture) {
      this.options.onComment(capture);
    }
  };

  private _button: HTMLButtonElement;
  private _capture: ISelectionCapture<T> | null = null;
  private _timer = 0;
  private _isDisposed = false;
}
