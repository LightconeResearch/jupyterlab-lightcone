import { ServerConnection } from '@jupyterlab/services';
import type { IComment } from '../comments-api';
import {
  createComment,
  deleteComment,
  listComments,
  updateComment
} from '../comments-api';
import { NULL_VERSION, pointAnchor } from '../comment-model';
import { CommentService } from '../comment-service';

jest.mock('../comments-api', () => ({
  listComments: jest.fn(),
  createComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn()
}));

const settings = ServerConnection.makeSettings();

function comment(
  id: string,
  label: number,
  status: 'pending' | 'sent' = 'pending'
): IComment {
  return {
    id,
    created: '2026-09-23T10:00:00Z',
    updated: null,
    author: '',
    status,
    sentWith: null,
    label,
    text: `note ${id}`,
    target: {
      kind: 'record',
      path: 'project/astra.yaml',
      record: 'outputs.hubble_diagram',
      universe: null,
      message: null,
      version: NULL_VERSION
    },
    anchor: pointAnchor(10, 20)
  };
}

const list = jest.mocked(listComments);
const create = jest.mocked(createComment);
const update = jest.mocked(updateComment);
const remove = jest.mocked(deleteComment);

beforeEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();
});

describe('CommentService', () => {
  it('fetches pending comments once on first use and shares the request', async () => {
    let resolve: (comments: IComment[]) => void = () => undefined;
    list.mockReturnValue(
      new Promise<IComment[]>(done => {
        resolve = done;
      })
    );
    const service = new CommentService(settings);
    const changes: string[] = [];
    service.changed.connect((_sender, entrypoint) => changes.push(entrypoint));
    expect(service.pending('./project/astra.yaml')).toEqual([]);
    expect(service.pending('project/astra.yaml')).toEqual([]);
    expect(service.known('project/astra.yaml')).toBe(false);
    const refreshing = service.refresh('project/astra.yaml');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(settings, 'project/astra.yaml', {
      status: 'pending'
    });
    resolve([comment('a', 1)]);
    await refreshing;
    expect(service.known('project/astra.yaml')).toBe(true);
    expect(service.pending('./project/astra.yaml').map(c => c.id)).toEqual([
      'a'
    ]);
    expect(changes).toEqual(['project/astra.yaml']);
    service.dispose();
  });

  it('emits only when the pending list actually changed', async () => {
    list.mockResolvedValue([comment('a', 1)]);
    const service = new CommentService(settings);
    const changes: string[] = [];
    service.changed.connect((_sender, entrypoint) => changes.push(entrypoint));
    await service.refresh('project/astra.yaml');
    await service.refresh('project/astra.yaml');
    expect(changes).toHaveLength(1);
    list.mockResolvedValue([comment('a', 1), comment('b', 2)]);
    await service.refresh('project/astra.yaml');
    expect(changes).toHaveLength(2);
    service.dispose();
  });

  it('adds, updates and removes through the cache', async () => {
    list.mockResolvedValue([comment('a', 1)]);
    create.mockResolvedValue(comment('b', 2));
    update.mockResolvedValue({ ...comment('a', 1), text: 'edited' });
    remove.mockResolvedValue(undefined);
    const service = new CommentService(settings);
    await service.refresh('project/astra.yaml');
    const draft = {
      text: 'note b',
      target: comment('b', 2).target,
      anchor: pointAnchor(1, 2)
    };
    await service.add('project/astra.yaml', draft);
    expect(create).toHaveBeenCalledWith(settings, 'project/astra.yaml', draft);
    expect(service.pending('project/astra.yaml').map(c => c.id)).toEqual([
      'a',
      'b'
    ]);
    await service.update('project/astra.yaml', 'a', { text: 'edited' });
    expect(service.pending('project/astra.yaml')[0].text).toBe('edited');
    list.mockResolvedValue([{ ...comment('b', 1) }]);
    await service.remove('project/astra.yaml', 'a');
    expect(remove).toHaveBeenCalledWith(settings, 'project/astra.yaml', 'a');
    // Labels are renumbered by the server, so the list is fetched again.
    expect(list).toHaveBeenCalledTimes(2);
    expect(service.pending('project/astra.yaml')).toEqual([comment('b', 1)]);
    service.dispose();
  });

  it('reports a delete as done even when the renumbered list cannot be fetched', async () => {
    list.mockResolvedValueOnce([comment('a', 1), comment('b', 2)]);
    remove.mockResolvedValue(undefined);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const service = new CommentService(settings);
    await service.refresh('project/astra.yaml');
    list.mockRejectedValueOnce(new Error('offline'));
    await expect(
      service.remove('project/astra.yaml', 'a')
    ).resolves.toBeUndefined();
    expect(service.pending('project/astra.yaml').map(c => c.id)).toEqual(['b']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    service.dispose();
  });

  it('reuses the full listing for a while and drops it after a write', async () => {
    jest.useFakeTimers({ now: 0 });
    list.mockImplementation(async (_settings, _entrypoint, query) =>
      query?.status === 'all'
        ? [comment('a', 1), comment('s', 1, 'sent')]
        : [comment('a', 1)]
    );
    create.mockResolvedValue(comment('b', 2));
    const service = new CommentService(settings);
    const first = await service.all('project/astra.yaml');
    expect(first.map(c => c.id)).toEqual(['a', 's']);
    await service.all('project/astra.yaml');
    expect(list).toHaveBeenCalledTimes(1);
    jest.setSystemTime(31_000);
    await service.all('project/astra.yaml');
    expect(list).toHaveBeenCalledTimes(2);
    await service.add('project/astra.yaml', {
      text: 'x',
      target: comment('b', 2).target,
      anchor: pointAnchor(0, 0)
    });
    await service.all('project/astra.yaml');
    expect(list).toHaveBeenCalledTimes(3);
    service.dispose();
  });
});
