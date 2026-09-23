import type { IInputModel } from '@jupyter/chat';
import { ServerConnection } from '@jupyterlab/services';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { ChatProjects } from '../chat-projects';
import { commentDelivery, listComments, sendComments } from '../comments-api';
import { pointAnchor } from '../comment-model';
import { CommentService } from '../comment-service';
import { commentCommandProvider } from '../index';
import { makeComment } from './fixtures';

jest.mock('@jupyter/chat', () => {
  const { Token } = jest.requireActual('@lumino/coreutils');
  return {
    IChatCommandRegistry: new Token('@jupyter/chat:commands'),
    IChatTracker: new Token('@jupyter/chat:IChatTracker'),
    IMessagePreambleRegistry: new Token('@jupyter/chat:preambles')
  };
});
jest.mock('../comments-api', () => ({
  ...jest.requireActual('../comments-api'),
  listComments: jest.fn(),
  createComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn(),
  sendComments: jest.fn()
}));
jest.mock('../../commands', () => ({
  CommandIDs: { openElement: 'jupyterlab_lightcone:open-element' }
}));
jest.mock('../../element-widget', () => ({ ElementWidget: class {} }));

const settings = ServerConnection.makeSettings();

/** The part of Jupyter Chat's input model the provider uses. */
function fakeInput(name: string, metadata: Record<string, unknown> = {}) {
  const state = {
    chatContext: { name },
    isDisposed: false,
    value: 'Please fix these.',
    metadata,
    getMetadata: () => state.metadata,
    updateMetadata: jest.fn((patch: Record<string, unknown>) => {
      state.metadata = { ...state.metadata, ...patch };
    })
  };
  return { state, input: state as unknown as IInputModel };
}

function setup(delivery: 'prompt' | 'message' = 'prompt') {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(analysis('demo')),
    'project/chats/talk.chat': fileModel('{}'),
    'loose/talk.chat': fileModel('{}')
  });
  const service = new CommentService(settings);
  const provider = commentCommandProvider(
    service,
    new ChatProjects(contents),
    delivery
  );
  return { service, provider };
}

beforeEach(() => {
  jest.mocked(listComments).mockReset();
  jest.mocked(sendComments).mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the comments chat command provider', () => {
  it('sends the pending comment ids with the next message only', async () => {
    jest
      .mocked(listComments)
      .mockResolvedValue([
        makeComment('a', pointAnchor(1, 2)),
        makeComment('b', pointAnchor(3, 4), { label: 2 })
      ]);
    const { provider, service } = setup();
    const { state, input } = fakeInput('project/chats/talk.chat', {
      agent: 'claude',
      lightcone: { other: true }
    });
    await provider.onSubmit(input);
    // What rides with the message: the ids, beside the input's own metadata.
    expect(state.metadata).toEqual({
      agent: 'claude',
      lightcone: { other: true, comments: ['a', 'b'] }
    });
    jest.advanceTimersByTime(0);
    expect(state.metadata).toEqual({
      agent: 'claude',
      lightcone: { other: true, comments: [] }
    });
    expect(listComments).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(listComments).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('keeps the message text as typed when the server appends to the prompt', async () => {
    jest
      .mocked(listComments)
      .mockResolvedValue([makeComment('a', pointAnchor(1, 2))]);
    const { provider, service } = setup('prompt');
    const { state, input } = fakeInput('project/chats/talk.chat');
    await provider.onSubmit(input);
    expect(sendComments).not.toHaveBeenCalled();
    expect(state.value).toBe('Please fix these.');
    service.dispose();
  });

  it('appends the block to the message where the server would not', async () => {
    jest
      .mocked(listComments)
      .mockResolvedValue([makeComment('a', pointAnchor(1, 2))]);
    jest
      .mocked(sendComments)
      .mockResolvedValue('Comments on this project (1):\n① outputs.fig');
    const { provider, service } = setup('message');
    const { state, input } = fakeInput('project/chats/talk.chat');
    await provider.onSubmit(input);
    expect(sendComments).toHaveBeenCalledWith(
      settings,
      'project/astra.yaml',
      ['a'],
      'project/chats/talk.chat'
    );
    expect(state.value).toBe(
      'Please fix these.\n\nComments on this project (1):\n① outputs.fig'
    );
    // The ids still ride along, so the message shows the comments as cards.
    expect(state.metadata).toEqual({ lightcone: { comments: ['a'] } });
    expect(service.pending('project/astra.yaml')).toEqual([]);
    service.dispose();
  });

  it('reads the delivery the server stated in the page configuration', () => {
    expect(commentDelivery('prompt')).toBe('prompt');
    expect(commentDelivery('message')).toBe('message');
    expect(commentDelivery('')).toBe('message');
  });

  it('leaves messages alone without a project or pending comments', async () => {
    jest.mocked(listComments).mockResolvedValue([]);
    const { provider, service } = setup();
    const loose = fakeInput('loose/talk.chat');
    await provider.onSubmit(loose.input);
    expect(loose.state.updateMetadata).not.toHaveBeenCalled();
    const empty = fakeInput('project/chats/talk.chat');
    await provider.onSubmit(empty.input);
    expect(empty.state.updateMetadata).not.toHaveBeenCalled();
    service.dispose();
  });
});
