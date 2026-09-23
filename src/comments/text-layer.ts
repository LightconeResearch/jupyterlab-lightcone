import type { IDisposable } from '@lumino/disposable';
import type { IComment } from './comments-api';
import { labelGlyph } from './comment-model';
import { flashElement } from './editor-comments';
import { findQuote, type ITextSpan } from './text-anchor';
import { COMMENT_HOST_CLASS, COMMENT_LAYER_CLASS } from './image-layer';

const BADGE_CLASS = 'jp-jupyterlab-lightcone-CommentBadge';
const HIGHLIGHT_CLASS = 'jp-jupyterlab-lightcone-CommentHighlight';

export interface ITextLayerOptions {
  /** The widget node the layer covers; it becomes a positioned container. */
  host: HTMLElement;
  /** The element whose text is searched; the host by default. */
  textRoot?(): HTMLElement | null;
  /** A click on a pending comment's badge. */
  onBadgeClick(
    comment: IComment,
    element: HTMLElement,
    event: MouseEvent
  ): void;
}

interface ITextIndex {
  text: string;
  nodes: { node: Text; start: number }[];
}

/** The text of an element as the browser lays it out, with node offsets. */
export function indexText(
  root: HTMLElement,
  skip: (node: Node) => boolean
): ITextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      skip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  let text = '';
  const nodes: ITextIndex['nodes'] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue;
    }
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

/** A DOM range over raw offsets of an indexed text. */
export function rangeForSpan(index: ITextIndex, span: ITextSpan): Range | null {
  const locate = (offset: number, end: boolean) => {
    let low = 0;
    let high = index.nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (index.nodes[middle].start <= offset - (end ? 1 : 0)) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const entry = index.nodes[low];
    return entry
      ? {
          node: entry.node,
          offset: Math.min(entry.node.length, offset - entry.start)
        }
      : null;
  };
  const start = locate(span.from, false);
  const finish = locate(span.to, true);
  if (!start || !finish) {
    return null;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(finish.node, finish.offset);
  return range;
}

/**
 * Numbered badges and highlights where pending comments' quotes appear in a
 * rendered view. Like the image layer, it lives beside the content and
 * measures it, so it survives React re-renders and pdf.js page redraws.
 */
export class TextCommentLayer implements IDisposable {
  constructor(private options: ITextLayerOptions) {
    const { host } = options;
    host.classList.add(COMMENT_HOST_CLASS);
    this._layer = document.createElement('div');
    this._layer.className = COMMENT_LAYER_CLASS;
    host.appendChild(this._layer);
    host.addEventListener('scroll', this.reposition, true);
    this._resizes = new ResizeObserver(this.reposition);
    this._resizes.observe(host);
    this._mutations = new MutationObserver(records => {
      if (records.some(record => !this._layer.contains(record.target))) {
        this.schedule();
      }
    });
    this._mutations.observe(host, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.addEventListener('resize', this.reposition);
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Show these comments' text and PDF anchors. */
  setComments(comments: readonly IComment[]): void {
    this._comments = comments.filter(
      comment => comment.anchor.type !== 'point' && !!comment.anchor.quote
    );
    this.schedule();
  }

  /** Scroll a badge into view and flash it; remembered until it exists. */
  flash(id: string): void {
    this._flash = id;
    this.schedule();
  }

  /** Search the text again on the next frame. */
  schedule = (): void => {
    this._dirty = true;
    this.reposition();
  };

  /** Move badges to where their ranges are now. */
  reposition = (): void => {
    if (this._isDisposed || this._frame !== null) {
      return;
    }
    this._frame = window.requestAnimationFrame(() => {
      this._frame = null;
      if (this._dirty) {
        this._dirty = false;
        this.search();
      }
      this.render();
    });
  };

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    if (this._frame !== null) {
      window.cancelAnimationFrame(this._frame);
    }
    const { host } = this.options;
    host.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition);
    this._resizes.disconnect();
    this._mutations.disconnect();
    this._layer.remove();
    host.classList.remove(COMMENT_HOST_CLASS);
  }

  private search(): void {
    const root = this.options.textRoot?.() ?? this.options.host;
    this._ranges.clear();
    if (!root || !this._comments.length) {
      return;
    }
    const skip = (node: Node) =>
      this._layer.contains(node) ||
      !!node.parentElement?.closest('.cm-editor, script, style');
    const whole = indexText(root, skip);
    const pages = new Map<number, ITextIndex>();
    for (const comment of this._comments) {
      const { anchor } = comment;
      let index = whole;
      if (anchor.type === 'pdf' && anchor.page !== null) {
        const page = root.querySelector<HTMLElement>(
          `[data-page="${anchor.page}"], [data-page-number="${anchor.page}"]`
        );
        if (page) {
          let cached = pages.get(anchor.page);
          if (!cached) {
            cached = indexText(page, skip);
            pages.set(anchor.page, cached);
          }
          index = cached;
        }
      }
      const span = findQuote(index.text, anchor.quote ?? '', anchor.prefix);
      const range = span ? rangeForSpan(index, span) : null;
      if (range) {
        this._ranges.set(comment.id, range);
      }
    }
  }

  private render(): void {
    // React clears the host's children on its first render, taking the layer
    // with it; put it back beside the rendered content.
    if (!this._layer.isConnected) {
      this.options.host.appendChild(this._layer);
    }
    const hostRect = this.options.host.getBoundingClientRect();
    const live = new Set<string>();
    for (const comment of this._comments) {
      const range = this._ranges.get(comment.id);
      if (!range) {
        continue;
      }
      const rects = Array.from(range.getClientRects()).filter(
        rect => rect.width > 0 && rect.height > 0
      );
      if (!rects.length) {
        continue;
      }
      live.add(comment.id);
      let entry = this._nodes.get(comment.id);
      if (!entry) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = BADGE_CLASS;
        badge.dataset.commentId = comment.id;
        badge.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const current = this._comments.find(item => item.id === comment.id);
          if (current) {
            this.options.onBadgeClick(current, badge, event);
          }
        });
        this._layer.appendChild(badge);
        entry = { badge, highlights: [] };
        this._nodes.set(comment.id, entry);
      }
      entry.badge.textContent = labelGlyph(comment.label);
      entry.badge.title = comment.text;
      entry.badge.setAttribute(
        'aria-label',
        `Comment ${comment.label}: ${comment.text}`
      );
      const first = rects[0];
      entry.badge.style.left = `${first.left - hostRect.left}px`;
      entry.badge.style.top = `${first.top - hostRect.top}px`;
      entry.badge.style.height = `${first.height}px`;
      while (entry.highlights.length > rects.length) {
        entry.highlights.pop()?.remove();
      }
      rects.forEach((rect, position) => {
        let box = entry!.highlights[position];
        if (!box) {
          box = document.createElement('div');
          box.className = HIGHLIGHT_CLASS;
          this._layer.insertBefore(box, entry!.badge);
          entry!.highlights.push(box);
        }
        box.style.left = `${rect.left - hostRect.left}px`;
        box.style.top = `${rect.top - hostRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      });
      if (this._flash === comment.id) {
        this._flash = null;
        range.startContainer.parentElement?.scrollIntoView({
          block: 'center'
        });
        flashElement(entry.badge);
        this.reposition();
      }
    }
    for (const [id, entry] of this._nodes) {
      if (!live.has(id)) {
        entry.badge.remove();
        for (const box of entry.highlights) {
          box.remove();
        }
        this._nodes.delete(id);
      }
    }
  }

  private _layer: HTMLElement;
  private _resizes: ResizeObserver;
  private _mutations: MutationObserver;
  private _comments: readonly IComment[] = [];
  private _ranges = new Map<string, Range>();
  private _nodes = new Map<
    string,
    { badge: HTMLElement; highlights: HTMLElement[] }
  >();
  private _flash: string | null = null;
  private _frame: number | null = null;
  private _dirty = true;
  private _isDisposed = false;
}
