import type { IInputModel } from '@jupyter/chat';
import { ServerConnection } from '@jupyterlab/services';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { ChatProjects } from '../chat-projects';
import { listComments } from '../comments-api';
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
  listComments: jest.fn(),
  createComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn()
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
    metadata,
    getMetadata: () => state.metadata,
    updateMetadata: jest.fn((patch: Record<string, unknown>) => {
      state.metadata = { ...state.metadata, ...patch };
    })
  };
  return { state, input: state as unknown as IInputModel };
}

function setup() {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(analysis('demo')),
    'project/chats/talk.chat': fileModel('{}'),
    'loose/talk.chat': fileModel('{}')
  });
  const service = new CommentService(settings);
  const provider = commentCommandProvider(service, new ChatProjects(contents));
  return { service, provider };
}

beforeEach(() => {
  jest.mocked(listComments).mockReset();
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
