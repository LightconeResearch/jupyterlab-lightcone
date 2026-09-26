/**
 * Jupyter Chat's module-private RENDERED_CLASS, from
 * components/messages/message-renderer: only rendered Markdown is rewritten.
 * Replace this hook when Chat exposes a per-message URL resolver.
 */
export const RENDERED_MESSAGE_CLASS = 'jp-chat-rendered-message';
export const RENDERED_MESSAGE_SELECTOR = `.${RENDERED_MESSAGE_CLASS}`;

/** Chat's module-private INPUT_BOX_CLASS, from input/chat-input. */
export const INPUT_CONTAINER_CLASS = 'jp-chat-input-container';
export const INPUT_CONTAINER_SELECTOR = `.${INPUT_CONTAINER_CLASS}`;

/** The list preceding the composer, used to match native chat layouts. */
export const MESSAGES_CONTAINER_CLASS = 'jp-chat-messages-container';

/** The input box of the composer whose input model has `inputId`. */
export function inputContainerSelector(inputId: string): string {
  return `${INPUT_CONTAINER_SELECTOR}[data-input-id="${CSS.escape(inputId)}"]`;
}
