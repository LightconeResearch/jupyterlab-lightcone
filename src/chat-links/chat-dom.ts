import { MESSAGE_CONTAINER_CLASS } from '@jupyter/chat';

/**
 * The parts of Jupyter Chat's DOM the workbench hangs on to, named once.
 *
 * `@jupyter/chat` renders above the input, decorates rendered messages and
 * indexes messages without a hook, so the sources key on its class names.
 * Only `MESSAGE_CONTAINER_CLASS` is exported by the package; the others are
 * module-private constants of `lib/components`, restated here with their
 * source so a version bump is a one-line change:
 *
 * - `INPUT_BOX_CLASS` in `input/chat-input.js`, on the box that also carries
 *   `data-input-id={model.id}`;
 * - `MESSAGES_BOX_CLASS` in `messages/messages.js`, the list of messages
 *   that precedes the input box;
 * - `RENDERED_CLASS` in `messages/message-renderer.js`, on the rendered
 *   Markdown of a message.
 */

export { MESSAGE_CONTAINER_CLASS };

/** The class of the list of messages, which the input box follows. */
export const MESSAGES_CONTAINER_CLASS = 'jp-chat-messages-container';

/** The class of the box holding a chat's composer. */
export const INPUT_CONTAINER_CLASS = 'jp-chat-input-container';

/** The class of a message's rendered Markdown; toolbars and avatars lie outside it. */
export const RENDERED_MESSAGE_CLASS = 'jp-chat-rendered-message';

/**
 * One message of a transcript; its `data-index` indexes the model's
 * messages, which is all the container says about the message.
 */
export const CHAT_MESSAGE_SELECTOR = `.${MESSAGE_CONTAINER_CLASS}[data-index]`;

export const INPUT_CONTAINER_SELECTOR = `.${INPUT_CONTAINER_CLASS}`;

export const RENDERED_MESSAGE_SELECTOR = `.${RENDERED_MESSAGE_CLASS}`;

/** The input box of the composer whose input model has `inputId`. */
export function inputContainerSelector(inputId: string): string {
  return `${INPUT_CONTAINER_SELECTOR}[data-input-id="${CSS.escape(inputId)}"]`;
}
