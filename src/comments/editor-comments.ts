import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  showTooltip,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type Tooltip
} from '@codemirror/view';
import type { IComment, ICommentAnchor } from './comments-api';
import { labelGlyph } from './comment-model';
import { locateAnchor, textAnchorFromRange } from './text-anchor';

/** What the editor extension reports back to the comments plugin. */
export interface IEditorCommentHandlers {
  /** The user asked to comment on the current selection. */
  onComment(view: EditorView, anchor: ICommentAnchor): void;
  /** The user clicked a pending comment's badge. */
  onBadge(view: EditorView, comment: IComment, element: HTMLElement): void;
  /** An editor using the extension appeared. */
  onViewCreated(view: EditorView): void;
  /** That editor went away. */
  onViewDestroyed(view: EditorView): void;
}

/** Replace the pending comments an editor shows. */
export const setEditorComments = StateEffect.define<readonly IComment[]>();

/** The pending comments of the editor's document. */
export const editorCommentsField = StateField.define<readonly IComment[]>({
  create: () => [],
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorComments)) {
        return effect.value;
      }
    }
    return value;
  }
});

/** The anchor of the main selection, or null when it is empty. */
export function editorSelectionAnchor(
  state: EditorState
): ICommentAnchor | null {
  const range = state.selection.main;
  if (range.empty) {
    return null;
  }
  return textAnchorFromRange(state.doc, range.from, range.to);
}

class CommentBadgeWidget extends WidgetType {
  constructor(
    readonly comment: IComment,
    private handlers: IEditorCommentHandlers
  ) {
    super();
  }

  eq(other: CommentBadgeWidget): boolean {
    return (
      other.comment.id === this.comment.id &&
      other.comment.label === this.comment.label &&
      other.comment.text === this.comment.text
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'jp-jupyterlab-lightcone-CommentBadge';
    badge.dataset.commentId = this.comment.id;
    badge.textContent = labelGlyph(this.comment.label);
    badge.title = this.comment.text;
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onBadge(view, this.comment, badge);
    };
    badge.addEventListener('mousedown', open);
    badge.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        open(event);
      }
    });
    return badge;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const quoteMark = Decoration.mark({
  class: 'jp-jupyterlab-lightcone-CommentMark'
});

function buildBadges(
  state: EditorState,
  handlers: IEditorCommentHandlers
): DecorationSet {
  const ranges = [];
  for (const comment of state.field(editorCommentsField)) {
    if (comment.anchor.type !== 'text') {
      continue;
    }
    const span = locateAnchor(state.doc, comment.anchor);
    if (!span) {
      continue;
    }
    ranges.push(
      Decoration.widget({
        widget: new CommentBadgeWidget(comment, handlers),
        side: -1
      }).range(span.from)
    );
    if (span.to > span.from) {
      ranges.push(quoteMark.range(span.from, span.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * The editor extension: a floating Comment button on a non-empty selection,
 * and numbered badges where pending comments' quotes are found.
 */
export function editorCommentExtension(
  handlers: IEditorCommentHandlers
): Extension {
  const badges = StateField.define<DecorationSet>({
    create: state => buildBadges(state, handlers),
    update: (value, transaction) => {
      if (transaction.effects.some(effect => effect.is(setEditorComments))) {
        return buildBadges(transaction.state, handlers);
      }
      return transaction.docChanged ? value.map(transaction.changes) : value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const selectionTooltip = (state: EditorState): Tooltip | null => {
    const range = state.selection.main;
    if (range.empty) {
      return null;
    }
    return {
      pos: range.head,
      above: range.head < range.anchor,
      create: view => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jp-jupyterlab-lightcone-CommentButton';
        button.textContent = 'Comment';
        button.addEventListener('mousedown', event => {
          // Keep the editor selection while the popover opens.
          event.preventDefault();
        });
        button.addEventListener('click', event => {
          event.preventDefault();
          const anchor = editorSelectionAnchor(view.state);
          if (anchor) {
            handlers.onComment(view, anchor);
          }
        });
        return { dom: button };
      }
    };
  };
  const tooltip = StateField.define<Tooltip | null>({
    create: selectionTooltip,
    update: (value, transaction) =>
      transaction.selection || transaction.docChanged
        ? selectionTooltip(transaction.state)
        : value,
    provide: field => showTooltip.from(field)
  });
  const lifecycle = ViewPlugin.define(view => {
    handlers.onViewCreated(view);
    return {
      destroy: () => handlers.onViewDestroyed(view)
    };
  });
  return [editorCommentsField, badges, tooltip, lifecycle];
}

/** The editor's current pending comments, for callers holding a view. */
export function editorComments(view: EditorView): readonly IComment[] {
  return view.state.field(editorCommentsField, false) ?? [];
}

/** Scroll an editor to a pending comment and flash its badge. */
export function revealEditorComment(view: EditorView, id: string): boolean {
  const comment = editorComments(view).find(item => item.id === id);
  if (!comment) {
    return false;
  }
  const span = locateAnchor(view.state.doc, comment.anchor);
  if (!span) {
    return false;
  }
  view.dispatch({
    effects: EditorView.scrollIntoView(span.from, { y: 'center' })
  });
  window.requestAnimationFrame(() => {
    const badge = view.dom.querySelector<HTMLElement>(
      `.jp-jupyterlab-lightcone-CommentBadge[data-comment-id="${CSS.escape(id)}"]`
    );
    flashElement(badge);
  });
  return true;
}

/** Draw attention to a pin or badge for a moment. */
export function flashElement(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  element.classList.remove('jp-jupyterlab-lightcone-CommentFlash');
  // Restart the animation when the element is flashed twice in a row.
  void element.offsetWidth;
  element.classList.add('jp-jupyterlab-lightcone-CommentFlash');
  window.setTimeout(() => {
    element.classList.remove('jp-jupyterlab-lightcone-CommentFlash');
  }, 1600);
}
