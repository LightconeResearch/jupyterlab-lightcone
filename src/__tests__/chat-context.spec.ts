import {
  chatContexts,
  chatContextProvider,
  contextForChat,
  contextualArguments,
  type IChatContext
} from '../chat-context';

const context: IChatContext = {
  version: 1,
  entrypoint: 'first/astra.yaml',
  universeId: 'baseline'
};
const model = (history: IChatContext[], pending?: IChatContext) => ({
  messages: history.map(lightcone => ({
    content: { metadata: { lightcone } }
  })),
  input: { getMetadata: () => ({ lightcone: pending }) }
});

afterEach(() => chatContexts.clear());

test('adds agent-readable context only on submit, without duplicating it on retry', async () => {
  const input = {
    value: 'Compare the options.',
    attachments: [],
    getMetadata: () => ({ lightcone: context }),
    updateMetadata: jest.fn()
  };
  await chatContextProvider.onSubmit(input);
  expect(input.value).toContain(
    'Compare the options.\n\nASTRA context: "first/astra.yaml".'
  );
  expect(input.value).toContain('Use the bound universe "baseline"');
  const submitted = input.value;
  await chatContextProvider.onSubmit(input);
  expect(input.value).toBe(submitted);
});

test('leaves empty drafts and ordinary unbound chats untouched', async () => {
  const empty = {
    value: '',
    attachments: [],
    getMetadata: () => ({ lightcone: context }),
    updateMetadata: jest.fn()
  };
  await chatContextProvider.onSubmit(empty);
  expect(empty.value).toBe('');
  expect(empty.updateMetadata).not.toHaveBeenCalled();
  const unbound = { ...empty, value: 'Hello', getMetadata: () => ({}) };
  await chatContextProvider.onSubmit(unbound);
  expect(unbound.value).toBe('Hello');
  expect(unbound.updateMetadata).not.toHaveBeenCalled();
});

test('includes explicit defaults and rejects a conflicting history before sending', async () => {
  const input = {
    value: 'Explain this project.',
    attachments: [],
    getMetadata: () => ({ lightcone: { ...context, universeId: null } }),
    updateMetadata: jest.fn()
  };
  await chatContextProvider.onSubmit(input);
  expect(input.value).toContain('Use project defaults (no universe override)');
  const conflict = {
    ...input,
    chatContext: {
      id: 'chat',
      name: 'chat',
      users: [],
      user: undefined,
      messages: [
        {
          type: 'msg',
          id: 'earlier',
          time: 0,
          sender: { username: 'user' },
          body: 'Earlier request',
          metadata: { lightcone: context }
        }
      ]
    }
  };
  await expect(chatContextProvider.onSubmit(conflict)).rejects.toThrow(
    'conflicting'
  );
});

test('includes context when sending an attachment without prose', async () => {
  const input: Parameters<typeof chatContextProvider.onSubmit>[0] = {
    value: '',
    attachments: [{ type: 'file', value: 'first/astra.yaml' }],
    getMetadata: () => ({ lightcone: context }),
    updateMetadata: jest.fn()
  };
  await chatContextProvider.onSubmit(input);
  expect(input.value).toContain('Use the bound universe "baseline"');
  expect(input.attachments).toEqual([
    { type: 'file', value: 'first/astra.yaml' }
  ]);
});

test('restores context without inferring it from current files or reply text', () => {
  expect(contextForChat(model([context]))).toEqual(context);
  expect(contextForChat(model([], context))).toEqual(context);
  expect(contextForChat(model([]))).toBeUndefined();
  expect(() =>
    contextForChat(model([context, { ...context, universeId: null }]))
  ).toThrow('conflicting');
});

test('routes against the originating chat and rejects a project or universe switch', () => {
  chatContexts.set('first', context);
  chatContexts.set('second', {
    ...context,
    entrypoint: 'second/astra.yaml',
    universeId: null
  });
  expect(
    contextualArguments({
      chatId: 'first',
      target: 'outputs.fit',
      universeId: null
    })
  ).toMatchObject({ entrypoint: context.entrypoint, universeId: 'baseline' });
  expect(() => contextualArguments({ chatId: 'missing' })).toThrow(
    'NO_PROJECT_CONTEXT'
  );
  expect(() =>
    contextualArguments({ chatId: 'first', entrypoint: 'second/astra.yaml' })
  ).toThrow('PROJECT_MISMATCH');
  expect(() =>
    contextualArguments({ chatId: 'first', universeId: 'changed' })
  ).toThrow('UNIVERSE_MISMATCH');
});
