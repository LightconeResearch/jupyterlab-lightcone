import { ContentsManager, Drive, ServerConnection } from '@jupyterlab/services';
import { findProjectRoot, projectEntrypoint } from '../project-root';
import { fileModel } from './project-fixtures';

function host(specs: string[]) {
  const contents = new ContentsManager();
  contents.addDrive(new Drive({ name: 'archive' }));
  const get = jest.spyOn(contents, 'get').mockImplementation(async path => {
    if (!specs.includes(path))
      throw new ServerConnection.ResponseError(
        new Response('', { status: 404 })
      );
    return fileModel('', { path });
  });
  return { contents, get };
}

it('resolves the nearest project through subfolders and respects nested projects', async () => {
  const { contents } = host(['work/astra.yaml', 'work/nested/astra.yaml']);
  try {
    expect(await findProjectRoot(contents, 'work/data/raw')).toEqual({
      path: 'work',
      entrypoint: 'work/astra.yaml'
    });
    expect(await findProjectRoot(contents, 'work/nested/data')).toEqual({
      path: 'work/nested',
      entrypoint: 'work/nested/astra.yaml'
    });
  } finally {
    contents.dispose();
  }
});

it.each(['', 'archive:'])(
  'stops at the Contents drive root %s',
  async drive => {
    const { contents, get } = host(['astra.yaml']);
    try {
      const result = await findProjectRoot(contents, `${drive}data`);
      expect(result?.path).toBe(drive ? undefined : '');
      expect(get.mock.calls.map(([path]) => path)).toEqual([
        `${drive}data/astra.yaml`,
        `${drive}astra.yaml`
      ]);
    } finally {
      contents.dispose();
    }
  }
);

it.each([403, 500])(
  'preserves %s errors instead of treating them as missing projects',
  async status => {
    const { contents, get } = host([]);
    get.mockRejectedValue(
      new ServerConnection.ResponseError(new Response('', { status }))
    );
    try {
      await expect(
        findProjectRoot(contents, 'work/data')
      ).rejects.toHaveProperty('response.status', status);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      contents.dispose();
    }
  }
);

it('keeps the Contents drive in the missing-project fallback', async () => {
  const { contents } = host([]);
  try {
    expect(await projectEntrypoint(contents, 'archive:')).toBe(
      'archive:astra.yaml'
    );
  } finally {
    contents.dispose();
  }
});
