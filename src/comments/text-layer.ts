import type { IDisposable } from '@lumino/disposable';
import type { IComment } from './comments-api';
import { labelGlyph } from './comment-model';
import { flashElement } from './editor-comments';
import {
  findQuoteIn,
  normalizeForSearch,
  SEARCH_LIMIT,
  type INormalizedText,
  type ITextSpan
} from './text-anchor';
import {
  anchorLayer,
  COMMENT_HOST_CLASS,
  COMMENT_LAYER_CLASS,
  inCommentLayer,
  setAttribute,
  setText
} from './image-layer';

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

/** The text of an element, and where each of its text nodes starts in it. */
export interface ITextIndex {
  text: string;
  nodes: { node: Text; start: number }[];
}

/** The nodes drawn for one comment: its badge and one box per line. */
interface IBadgeNodes {
  badge: HTMLElement;
  highlights: HTMLElement[];
}

/**
 * Where a quote occurs in an indexed text, normalizing the text at most once
 * however many quotes are looked up in it. Texts beyond the search limit are
 * not searched, as in the editor.
 */
class QuoteSearch {
  constructor(readonly index: ITextIndex) {}

  find(quote: string, prefix: string | null): ITextSpan | null {
    if (this.index.text.length > SEARCH_LIMIT) {
      return null;
    }
    this._normalized ??= normalizeForSearch(this.index.text);
    return findQuoteIn(this._normalized, quote, prefix);
  }

  private _normalized: INormalizedText | null = null;
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

/**
 * A DOM range over raw offsets of an indexed text. The start lands in the
 * text node holding its first character; the end in the node holding the
 * last character, so a span ending exactly where a node ends stays in that
 * node rather than collapsing onto the start of the next one.
 */
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
      if (records.some(record => !inCommentLayer(record.target))) {
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
    // Pins and badges are drawn over the content, not part of it.
    const skip = (node: Node) =>
      inCommentLayer(node) ||
      !!node.parentElement?.closest('.cm-editor, script, style');
    // The whole text is indexed only when a comment is not tied to a page
    // found on screen: a paper's page comments search their page alone.
    let whole: QuoteSearch | null = null;
    const pages = new Map<number, QuoteSearch>();
    for (const comment of this._comments) {
      const { anchor } = comment;
      let search: QuoteSearch | undefined;
      if (anchor.type === 'pdf' && anchor.page !== null) {
        search = pages.get(anchor.page);
        if (!search) {
          const page = root.querySelector<HTMLElement>(
            `[data-page="${anchor.page}"], [data-page-number="${anchor.page}"]`
          );
          if (page) {
            search = new QuoteSearch(indexText(page, skip));
            pages.set(anchor.page, search);
          }
        }
      }
      if (!search) {
        whole ??= new QuoteSearch(indexText(root, skip));
        search = whole;
      }
      const span = search.find(anchor.quote ?? '', anchor.prefix);
      const range = span ? rangeForSpan(search.index, span) : null;
      if (range) {
        this._ranges.set(comment.id, range);
      }
    }
  }

  private render(): void {
    const origin = anchorLayer(this.options.host, this._layer);
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
      const { badge, highlights } =
        this._nodes.get(comment.id) ?? this.createEntry(comment.id);
      setText(badge, labelGlyph(comment.label));
      setAttribute(badge, 'title', comment.text);
      setAttribute(
        badge,
        'aria-label',
        `Comment ${comment.label}: ${comment.text}`
      );
      const first = rects[0];
      badge.style.left = `${first.left - origin.left}px`;
      badge.style.top = `${first.top - origin.top}px`;
      badge.style.height = `${first.height}px`;
      while (highlights.length > rects.length) {
        highlights.pop()?.remove();
      }
      rects.forEach((rect, position) => {
        let box = highlights[position];
        if (!box) {
          box = document.createElement('div');
          box.className = HIGHLIGHT_CLASS;
          this._layer.insertBefore(box, badge);
          highlights.push(box);
        }
        box.style.left = `${rect.left - origin.left}px`;
        box.style.top = `${rect.top - origin.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      });
      if (this._flash === comment.id) {
        this._flash = null;
        range.startContainer.parentElement?.scrollIntoView({
          block: 'center'
        });
        flashElement(badge);
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

  /** A comment's badge, which opens it, and its (still empty) highlights. */
  private createEntry(id: string): IBadgeNodes {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = BADGE_CLASS;
    badge.dataset.commentId = id;
    badge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const current = this._comments.find(item => item.id === id);
      if (current) {
        this.options.onBadgeClick(current, badge, event);
      }
    });
    this._layer.appendChild(badge);
    const entry: IBadgeNodes = { badge, highlights: [] };
    this._nodes.set(id, entry);
    return entry;
  }

  private _layer: HTMLElement;
  private _resizes: ResizeObserver;
  private _mutations: MutationObserver;
  private _comments: readonly IComment[] = [];
  private _ranges = new Map<string, Range>();
  private _nodes = new Map<string, IBadgeNodes>();
  private _flash: string | null = null;
  private _frame: number | null = null;
  private _dirty = true;
  private _isDisposed = false;
}
