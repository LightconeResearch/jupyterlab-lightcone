import { ServerConnection } from '@jupyterlab/services';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { ChatProjects, directoryOf } from '../chat-projects';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('directoryOf', () => {
  it('keeps a drive prefix', () => {
    expect(directoryOf('project/chats/a.chat')).toBe('project/chats');
    expect(directoryOf('drive:a/b.md')).toBe('drive:a');
    expect(directoryOf('drive:x.md')).toBe('drive:');
    expect(directoryOf('x.md')).toBe('');
  });
});

describe('ChatProjects', () => {
  it('remembers a chat project and looks for a missing one again later', async () => {
    jest.useFakeTimers({ now: 0 });
    const { contents, get } = createContents({
      'project/astra.yaml': fileModel(analysis('demo')),
      'project/chats/a.chat': fileModel('{}'),
      'loose/a.chat': fileModel('{}')
    });
    const projects = new ChatProjects(contents);
    await expect(projects.entrypointFor('project/chats/a.chat')).resolves.toBe(
      'project/astra.yaml'
    );
    const calls = get.mock.calls.length;
    await expect(projects.entrypointFor('project/chats/a.chat')).resolves.toBe(
      'project/astra.yaml'
    );
    await expect(projects.entrypointFor('loose/a.chat')).resolves.toBeNull();
    const afterMiss = get.mock.calls.length;
    expect(afterMiss).toBeGreaterThan(calls);
    await projects.entrypointFor('loose/a.chat');
    expect(get.mock.calls.length).toBe(afterMiss);
    jest.setSystemTime(31_000);
    await projects.entrypointFor('loose/a.chat');
    expect(get.mock.calls.length).toBeGreaterThan(afterMiss);
    // A project found once is trusted for good.
    const beforeHit = get.mock.calls.length;
    await projects.entrypointFor('project/chats/a.chat');
    expect(get.mock.calls.length).toBe(beforeHit);
  });

  it('answers null when the folders cannot be read', async () => {
    const { contents, get } = createContents({});
    get.mockRejectedValue(
      new ServerConnection.ResponseError(new Response('', { status: 500 }))
    );
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const projects = new ChatProjects(contents);
    await expect(
      projects.entrypointFor('project/chats/a.chat')
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
