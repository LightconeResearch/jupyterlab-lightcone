import { EditorState } from '@codemirror/state';
import { EditorView, showTooltip, type DecorationSet } from '@codemirror/view';
import type { IComment } from '../comments-api';
import { emptyAnchor, NULL_VERSION } from '../comment-model';
import {
  editorCommentExtension,
  editorCommentsField,
  editorSelectionAnchor,
  setEditorComments,
  type IEditorCommentHandlers
} from '../editor-comments';

const doc = ['# Title', '', 'The magnitude offset is profiled.'].join('\n');

function handlers(): jest.Mocked<IEditorCommentHandlers> {
  return {
    onComment: jest.fn(),
    onBadge: jest.fn(),
    onViewCreated: jest.fn(),
    onViewDestroyed: jest.fn()
  };
}

function comment(quote: string, label = 1): IComment {
  return {
    id: `c${label}`,
    created: '2026-09-23T10:00:00Z',
    updated: null,
    author: '',
    status: 'pending',
    sentWith: null,
    label,
    text: 'Explain why.',
    target: {
      kind: 'file',
      path: 'project/index.md',
      record: null,
      universe: null,
      message: null,
      version: NULL_VERSION
    },
    anchor: { ...emptyAnchor('text'), quote, prefix: null }
  };
}

function decorationSizes(state: EditorState): number[] {
  return state
    .facet(EditorView.decorations)
    .filter((item): item is DecorationSet => typeof item !== 'function')
    .map(set => set.size);
}

describe('selection anchors', () => {
  it('is null without a selection and describes one otherwise', () => {
    const empty = EditorState.create({ doc });
    expect(editorSelectionAnchor(empty)).toBeNull();
    const from = doc.indexOf('magnitude');
    const state = EditorState.create({
      doc,
      selection: { anchor: from, head: from + 'magnitude offset'.length }
    });
    expect(editorSelectionAnchor(state)).toMatchObject({
      startLine: 3,
      startCol: 5,
      endLine: 3,
      endCol: 5 + 'magnitude offset'.length,
      quote: 'magnitude offset',
      prefix: '# Title\n\nThe '
    });
  });
});

describe('the editor extension', () => {
  it('offers a Comment tooltip only while text is selected', () => {
    const extensions = editorCommentExtension(handlers());
    const idle = EditorState.create({ doc, extensions });
    expect(idle.facet(showTooltip).filter(Boolean)).toHaveLength(0);
    const selected = idle.update({ selection: { anchor: 0, head: 7 } }).state;
    const tooltips = selected.facet(showTooltip).filter(Boolean);
    expect(tooltips).toHaveLength(1);
    expect(tooltips[0]?.pos).toBe(7);
    const backwards = idle.update({ selection: { anchor: 7, head: 0 } }).state;
    expect(backwards.facet(showTooltip).filter(Boolean)[0]).toMatchObject({
      pos: 0,
      above: true
    });
  });

  it('decorates the quotes of pending comments and follows edits', () => {
    const extensions = editorCommentExtension(handlers());
    let state = EditorState.create({ doc, extensions });
    expect(state.field(editorCommentsField)).toEqual([]);
    expect(decorationSizes(state)).toEqual([0]);
    state = state.update({
      effects: setEditorComments.of([
        comment('magnitude offset'),
        comment('nowhere to be found', 2)
      ])
    }).state;
    expect(state.field(editorCommentsField)).toHaveLength(2);
    // One badge and one mark for the quote that exists.
    expect(decorationSizes(state)).toEqual([2]);
    const inserted = state.update({
      changes: { from: 0, insert: 'intro\n' }
    }).state;
    expect(decorationSizes(inserted)).toEqual([2]);
    let badgeAt = -1;
    inserted
      .facet(EditorView.decorations)
      .filter((item): item is DecorationSet => typeof item !== 'function')
      .forEach(set =>
        set.between(0, inserted.doc.length, from => {
          if (badgeAt < 0) {
            badgeAt = from;
          }
        })
      );
    expect(badgeAt).toBe(inserted.doc.toString().indexOf('magnitude'));
    const cleared = inserted.update({
      effects: setEditorComments.of([])
    }).state;
    expect(decorationSizes(cleared)).toEqual([0]);
  });

  it('reports the selection anchor when the button is pressed', () => {
    const callbacks = handlers();
    const state = EditorState.create({
      doc,
      selection: { anchor: 2, head: 7 },
      extensions: editorCommentExtension(callbacks)
    });
    const view = new EditorView({ state, parent: document.body });
    try {
      expect(callbacks.onViewCreated).toHaveBeenCalledWith(view);
      const tooltip = view.state.facet(showTooltip).find(Boolean);
      const dom = tooltip?.create(view).dom;
      expect(dom?.textContent).toBe('Comment');
      dom?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(callbacks.onComment).toHaveBeenCalledTimes(1);
      expect(callbacks.onComment.mock.calls[0][1]).toMatchObject({
        quote: 'Title',
        startLine: 1,
        startCol: 3
      });
    } finally {
      view.destroy();
    }
    expect(callbacks.onViewDestroyed).toHaveBeenCalledWith(view);
  });
});
