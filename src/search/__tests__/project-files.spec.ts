import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { skipsProjectEntry, walkProjectFiles } from '../project-files';

function project(paths: string[]) {
  return createContents(
    Object.fromEntries(paths.map(path => [path, fileModel('')]))
  );
}

describe('skipsProjectEntry', () => {
  it('leaves out tool folders and hidden result manifests only', () => {
    expect(skipsProjectEntry('', '.venv', 'directory')).toBe(true);
    expect(skipsProjectEntry('src', 'node_modules', 'directory')).toBe(true);
    expect(skipsProjectEntry('', '_build', 'directory')).toBe(true);
    expect(skipsProjectEntry('', '.venv', 'file')).toBe(false);
    expect(
      skipsProjectEntry('results/baseline', '.fit.manifest.json', 'file')
    ).toBe(true);
    expect(skipsProjectEntry('results/baseline', 'fit.json', 'file')).toBe(
      false
    );
    expect(skipsProjectEntry('results', '.hidden', 'file')).toBe(false);
    expect(skipsProjectEntry('', '.gitignore', 'file')).toBe(false);
  });
});

describe('walkProjectFiles', () => {
  it('lists files shallow first with project-relative folders and skips excluded entries', async () => {
    const { contents, get } = project([
      'work/astra.yaml',
      'work/README.md',
      'work/src/plot.py',
      'work/.venv/lib/site.py',
      'work/_build/site/index.html',
      'work/node_modules/pkg/index.js',
      'work/results/baseline/fit.json',
      'work/results/baseline/.fit.manifest.json',
      'work/a/b/c/deep.txt',
      'work/a/b/c/d/deeper.txt'
    ]);
    try {
      const files = await walkProjectFiles(contents, 'work');
      expect(files.map(file => file.path)).toEqual([
        'work/astra.yaml',
        'work/README.md',
        'work/src/plot.py',
        'work/results/baseline/fit.json',
        'work/a/b/c/deep.txt'
      ]);
      expect(files[2]).toEqual({
        path: 'work/src/plot.py',
        name: 'plot.py',
        directory: 'src',
        depth: 2
      });
      expect(files[3].directory).toBe('results/baseline');
      expect(files[4].depth).toBe(4);
      const listed = get.mock.calls.map(([path]) => path);
      expect(listed).not.toContain('work/.venv');
      expect(listed).not.toContain('work/_build');
      expect(listed).not.toContain('work/node_modules');
      expect(listed).not.toContain('work/a/b/c/d');
    } finally {
      contents.dispose();
    }
  });

  it('stops at the file limit and honours a custom depth', async () => {
    const { contents } = project([
      'p/one.txt',
      'p/two.txt',
      'p/three.txt',
      'p/sub/four.txt',
      'p/sub/five.txt',
      'p/sub/inner/six.txt'
    ]);
    try {
      expect(
        (await walkProjectFiles(contents, 'p', { limit: 4 })).map(
          file => file.name
        )
      ).toEqual(['one.txt', 'three.txt', 'two.txt', 'five.txt']);
      expect(
        (await walkProjectFiles(contents, 'p', { maxDepth: 1 })).map(
          file => file.name
        )
      ).toEqual(['one.txt', 'three.txt', 'two.txt']);
    } finally {
      contents.dispose();
    }
  });

  it('skips a folder it cannot list without failing the walk', async () => {
    const { contents, get } = project(['p/ok.txt', 'p/locked/secret.txt']);
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (path, options) => {
      if (path === 'p/locked') {
        throw new Error('Forbidden');
      }
      return original(path, options);
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const files = await walkProjectFiles(contents, 'p');
      expect(files.map(file => file.path)).toEqual(['p/ok.txt']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      contents.dispose();
    }
  });
});
