import type {
  IChatCommandProvider,
  IInputModel,
  IMessageMetadata
} from '@jupyter/chat';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import {
  parseElementReference,
  type IProjectContext
} from './element-reference';

export interface IChatContext extends IProjectContext {
  version: 1;
  universeId: string | null;
}

declare module '@jupyter/chat' {
  interface IMessageMetadata {
    lightcone?: IChatContext;
  }
}

// Only live, tracked chats may route an agent command. No global active-project fallback.
export const chatContexts = new Map<string, IChatContext>();

/** Persist the binding without changing the user's message or attachments. */
export function createChatContextProvider(
  ensureAvailable: () => Promise<void>
) {
  return {
    id: 'jupyterlab_lightcone:context',
    listCommandCompletions: async () => [],
    onSubmit: async (
      input: Pick<
        IInputModel,
        | 'value'
        | 'attachments'
        | 'chatContext'
        | 'getMetadata'
        | 'updateMetadata'
      >
    ) => {
      if (!input.value.trim() && !input.attachments.length) return;
      const context = contextForChat({
        messages: (input.chatContext?.messages ?? []).map(content => ({
          content
        })),
        input
      });
      if (!context) return;
      await ensureAvailable();
      input.updateMetadata({ lightcone: context });
    }
  } satisfies IChatCommandProvider;
}

/** Recover a fixed context from persisted messages, rejecting mixed histories. */
export function contextForChat(model: {
  messages: readonly { content: { metadata?: IMessageMetadata } }[];
  input: { getMetadata(): IMessageMetadata };
}): IChatContext | undefined {
  let context: IChatContext | undefined;
  for (const metadata of [
    ...model.messages.map(message => message.content.metadata),
    model.input.getMetadata()
  ]) {
    const candidate = metadata?.lightcone;
    if (!candidate) continue;
    if (candidate.version !== 1 || candidate.universeId === undefined)
      throw new Error(
        'Unsupported Lightcone chat context. Start a new discussion.'
      );
    const reference = parseElementReference({ ...candidate, target: '' });
    if (
      context &&
      (context.entrypoint !== candidate.entrypoint ||
        context.universeId !== candidate.universeId)
    )
      throw new Error(
        'This chat contains conflicting ASTRA projects or universes. Start a new discussion.'
      );
    context = {
      version: 1,
      entrypoint: reference.entrypoint,
      universeId: candidate.universeId
    };
  }
  return context;
}

/** Agent calls use the originating conversation's universe, even after focus changes. */
export function contextualArguments(
  args: ReadonlyPartialJSONObject
): ReadonlyPartialJSONObject {
  if (args.chatId === undefined) return args;
  const context =
    typeof args.chatId === 'string' ? chatContexts.get(args.chatId) : undefined;
  if (!context)
    throw new Error(
      'NO_PROJECT_CONTEXT: Start an ASTRA discussion in Lightcone Lab first.'
    );
  if (
    args.entrypoint !== undefined &&
    args.entrypoint !== null &&
    args.entrypoint !== context.entrypoint
  )
    throw new Error(
      'PROJECT_MISMATCH: Start a new discussion for another project.'
    );
  if (
    args.universeId !== undefined &&
    args.universeId !== null &&
    args.universeId !== context.universeId
  )
    throw new Error(
      'UNIVERSE_MISMATCH: Start a new discussion for another universe.'
    );
  return {
    ...args,
    entrypoint: context.entrypoint,
    universeId: context.universeId
  };
}
