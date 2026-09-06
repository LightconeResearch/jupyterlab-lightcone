import {
  chatContexts,
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
