import { ServerConnection } from '@jupyterlab/services';
import type { IProjectRoot } from '../../project-root';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  CHAT_PROJECT_METADATA,
  createChatProjectResolver,
  recordedChatProject,
  recordedProjectRoot
} from '../chat-project';

const OWNER = { path: 'project', entrypoint: 'project/astra.yaml' };
const OTHER = { path: 'other', entrypoint: 'other/astra.yaml' };
const CURRENT = { path: 'current', entrypoint: 'current/astra.yaml' };

function setup(current: () => IProjectRoot | null | undefined = () => CURRENT) {
  const { contents, get } = createContents({
    'project/astra.yaml': fileModel('name: p\n'),
    'other/astra.yaml': fileModel('name: o\n')
  });
  const fallback = jest.fn(current);
  const resolver = createChatProjectResolver(contents, fallback);
  return { contents, get, fallback, resolver };
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createChatProjectResolver', () => {
  it('prefers the project storing the chat file', async () => {
    const { resolver, fallback } = setup();
    await expect(
      resolver.resolve('project/chats/a.chat', OTHER.entrypoint)
    ).resolves.toEqual(OWNER);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps an unbound chat in the project recorded in it, whatever the current project', async () => {
    const { resolver, fallback } = setup();
    await expect(
      resolver.resolve('loose/a.chat', OTHER.entrypoint)
    ).resolves.toEqual(OTHER);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the current project, read on every call', async () => {
    let current: IProjectRoot | undefined = undefined;
    const { resolver } = setup(() => current);
    // While the current project is still being resolved, there is none...
    await expect(resolver.resolve('loose/a.chat')).resolves.toBeUndefined();
    // ...and the chat follows it as soon as it is known or changes.
    current = CURRENT;
    await expect(resolver.resolve('loose/a.chat')).resolves.toEqual(CURRENT);
    current = OTHER;
    await expect(resolver.resolve('loose/a.chat')).resolves.toEqual(OTHER);
  });

  it('ignores recorded entrypoints the server would reject', async () => {
    const { resolver } = setup();
    for (const recorded of [
      '/abs/astra.yaml',
      '../astra.yaml',
      'p/../astra.yaml',
      'drive:p/astra.yaml',
      'p/other.yaml',
      ''
    ]) {
      await expect(resolver.resolve('loose/a.chat', recorded)).resolves.toEqual(
        CURRENT
      );
    }
  });

  it('walks the folders once a minute per chat', async () => {
    const { resolver, get } = setup();
    await resolver.resolve('project/chats/a.chat');
    const walked = get.mock.calls.length;
    expect(walked).toBeGreaterThan(0);
    now += 59_000;
    await resolver.resolve('project/chats/a.chat');
    expect(get).toHaveBeenCalledTimes(walked);
    now += 2_000;
    await resolver.resolve('project/chats/a.chat');
    expect(get).toHaveBeenCalledTimes(walked * 2);
  });

  it('reports a failed walk, falls back, and walks again next time', async () => {
    const { resolver, get } = setup();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    get.mockRejectedValueOnce(
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

describe('recorded projects', () => {
  /** A Jupyter Chat model whose shared document holds `metadata`. */
  function labChatModel(metadata: Record<string, unknown>) {
    const map = new Map(Object.entries(metadata));
    return {
      sharedModel: {
        ydoc: {
          getMap: (name: string) => (name === 'metadata' ? map : new Map())
        }
      }
    };
  }

  it('reads the entrypoint the server recorded in the chat document', () => {
    expect(
      recordedChatProject(
        labChatModel({ [CHAT_PROJECT_METADATA]: 'other/astra.yaml' })
      )
    ).toBe('other/astra.yaml');
    expect(recordedChatProject(labChatModel({}))).toBeUndefined();
    expect(
      recordedChatProject(labChatModel({ [CHAT_PROJECT_METADATA]: 3 }))
    ).toBeUndefined();
    expect(recordedChatProject({ name: 'a.chat' })).toBeUndefined();
    expect(recordedChatProject({ sharedModel: {} })).toBeUndefined();
    expect(recordedChatProject(null)).toBeUndefined();
  });

  it('turns a recorded entrypoint into a project', () => {
    expect(recordedProjectRoot('other/astra.yaml')).toEqual(OTHER);
    expect(recordedProjectRoot('astra.yaml')).toEqual({
      path: '',
      entrypoint: 'astra.yaml'
    });
    expect(recordedProjectRoot(undefined)).toBeUndefined();
  });
});
