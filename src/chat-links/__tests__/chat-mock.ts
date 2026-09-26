import type { EditorView } from '@codemirror/view';
import { isRecord } from '../../api';

/**
 * The values of `@jupyter/chat` the sources under test read. The package is
 * ESM that jest does not transform, so a spec whose sources import values
 * from it mocks it with this module:
 * `jest.mock('@jupyter/chat', () => jest.requireActual('…/chat-mock'))`.
 */

/** As `lib/components/messages/message.js` exports it. */
export const MESSAGE_CONTAINER_CLASS = 'jp-chat-message-container';

/** A stand-in for `CodeMirrorEditor`: the part `getEditor` callers read. */
interface IEditorLike {
  editor: EditorView;
}

function isEditorLike(value: unknown): value is IEditorLike {
  return isRecord(value) && isRecord(value.editor);
}

/**
 * `getEditor` for the test doubles: a document widget whose `content.editor`
 * stands in for the file editor's `CodeMirrorEditor`.
 */
export function getEditor(widget: unknown): IEditorLike | null {
  if (!isRecord(widget) || !isRecord(widget.content)) {
    return null;
  }
  return isEditorLike(widget.content.editor) ? widget.content.editor : null;
}
