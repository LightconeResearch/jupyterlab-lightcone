import { ContentsManager, Drive, ServerConnection } from '@jupyterlab/services';
import type { IProjectRoot } from '../../project-root';
import { fetchChatProject } from '../../sessions/sessions-api';
import { createChatProjectResolver } from '../chat-project';

jest.mock('../../sessions/sessions-api', () => ({
  fetchChatProject: jest.fn()
}));

const OWNER = { path: 'project', entrypoint: 'project/astra.yaml' };
const OTHER = { path: 'other', entrypoint: 'other/astra.yaml' };
const CURRENT = { path: 'current', entrypoint: 'current/astra.yaml' };

/** The server's answer for each chat, as `chat_project` gives it. */
const ANSWERS: Record<string, string | null> = {
  'project/chats/a.chat': 'project/astra.yaml',
  'loose/recorded.chat': 'other/astra.yaml',
  'loose/a.chat': null,
  'astra-root.chat': 'astra.yaml'
};

function setup(current: () => IProjectRoot | null | undefined = () => CURRENT) {
  const contents = new ContentsManager();
  const fetch = jest.mocked(fetchChatProject);
  fetch.mockImplementation(async (_settings, path) => ANSWERS[path] ?? null);
  const fallback = jest.fn(current);
  const resolver = createChatProjectResolver(contents, fallback);
  return { contents, fetch, fallback, resolver };
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.mocked(fetchChatProject).mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createChatProjectResolver', () => {
  it("takes the server's answer: the project storing the chat, else the one it recorded", async () => {
    const { contents, resolver, fallback, fetch } = setup();
    await expect(resolver.resolve('project/chats/a.chat')).resolves.toEqual(
      OWNER
    );
    await expect(resolver.resolve('loose/recorded.chat')).resolves.toEqual(
      OTHER
    );
    await expect(resolver.resolve('astra-root.chat')).resolves.toEqual({
      path: '',
      entrypoint: 'astra.yaml'
    });
    expect(fallback).not.toHaveBeenCalled();
    // The server knows local Contents paths only.
    contents.addDrive(new Drive({ name: 'RTC' }));
    await resolver.resolve('RTC:elsewhere/talk.chat');
    expect(fetch).toHaveBeenLastCalledWith(
      expect.anything(),
      'elsewhere/talk.chat'
    );
  });

  it('falls back to the current project, read on every call, until the chat records one', async () => {
    let current: IProjectRoot | undefined = undefined;
    const { resolver, fetch } = setup(() => current);
    // While the current project is still being resolved, there is none...
    await expect(resolver.resolve('loose/a.chat')).resolves.toBeUndefined();
    // ...and the chat follows it as soon as it is known or changes.
    current = CURRENT;
    await expect(resolver.resolve('loose/a.chat')).resolves.toEqual(CURRENT);
    current = OTHER;
    await expect(resolver.resolve('loose/a.chat')).resolves.toEqual(OTHER);
    // A chat without a project is asked about again, since it may record one.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('asks the server once a minute per chat', async () => {
    const { resolver, fetch } = setup();
    await resolver.resolve('project/chats/a.chat');
    now += 59_000;
    await resolver.resolve('project/chats/a.chat');
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2_000;
    await resolver.resolve('project/chats/a.chat');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a failed request, falls back, and asks again next time', async () => {
    const { resolver, fetch } = setup();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetch.mockRejectedValueOnce(
      new ServerConnection.ResponseError(new Response('', { status: 500 }))
    );
    await expect(resolver.resolve('project/chats/a.chat')).resolves.toEqual(
      CURRENT
    );
    expect(warn).toHaveBeenCalled();
    await expect(resolver.resolve('project/chats/a.chat')).resolves.toEqual(
      OWNER
    );
  });
});
