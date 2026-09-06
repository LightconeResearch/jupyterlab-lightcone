import { ProjectPathError } from '@astra-spec/sdk';
import { Drive } from '@jupyterlab/services';
import { projectDirectory, resolveProject } from '../project-data';
import { createJupyterProjectReader } from '../project-reader';
import { analysis, createContents, fileModel } from './project-fixtures';

jest.mock('../api', () => ({ collectPaperMetadata: jest.fn() }));

describe('Jupyter project reader', () => {
  it('reads text and shares adjacent file metadata within one resolution', async () => {
    const { contents, get } = createContents({
      'work/astra.yaml': fileModel(analysis('Example')),
      'work/results/default/plot.png': fileModel('image', { size: 42 }),
      'work/results/default/table.csv': fileModel('a,b\n1,2\n')
    });
    try {
      const reader = createJupyterProjectReader(contents, 'work');
      expect(await reader.readText('astra.yaml')).toBe(analysis('Example'));
      expect(await reader.stat('results/default/plot.png')).toEqual({
        type: 'file',
        size: 42,
        modifiedAtMs: Date.parse('2026-08-27T07:00:00.000Z')
      });
      expect(await reader.stat('results/default/missing.csv')).toBeUndefined();
      expect(await reader.stat('results/default/table.csv')).toMatchObject({
        type: 'file'
      });
      expect(await reader.readDirectory('results/default')).toEqual([
        { name: 'plot.png', type: 'file' },
        { name: 'table.csv', type: 'file' }
      ]);
      expect(get.mock.calls.map(([path]) => path)).toEqual([
        'work/astra.yaml',
        'work',
        'work/results',
        'work/results/default'
      ]);
    } finally {
      contents.dispose();
    }
  });

  it('avoids missing-directory requests and discovers results on the next resolution', async () => {
    const entries = {
      'work/astra.yaml': fileModel(
        'version: "0.0.14"\nname: Artifacts\ninputs: []\noutputs:\n  - id: plot\n    type: figure\n    format: png\n'
      )
    };
    const { contents, get } = createContents(entries);
    try {
      for (let refresh = 0; refresh < 2; refresh++) {
        const { bundle } = await resolveProject(contents, 'work/astra.yaml');
        expect(bundle.bindings).toHaveLength(0);
      }
      expect(get.mock.calls.some(([path]) => path.includes('/results'))).toBe(
        false
      );
      Object.assign(entries, {
        'work/results/default/plot.png': fileModel('image', { size: 42 })
      });
      const { bundle } = await resolveProject(contents, 'work/astra.yaml');
      expect(bundle.bindings[0].path).toBe('results/default/plot.png');
    } finally {
      contents.dispose();
    }
  });

  it('can list a child directory when its parent listing is denied', async () => {
    const { contents, get } = createContents({
      'work/results/default/plot.png': fileModel('image', { size: 42 })
    });
    const original = get.getMockImplementation();
    get.mockImplementation(async (path, options) => {
      if (path === 'work' || path === 'work/results') {
        throw { response: { status: 403 } };
      }
      return original!(path, options);
    });
    try {
      const reader = createJupyterProjectReader(contents, 'work');
      expect(await reader.stat('results/default/plot.png')).toMatchObject({
        size: 42
      });
    } finally {
      contents.dispose();
    }
  });

  it('supports project entrypoints at a registered drive root', async () => {
    const { contents, get } = createContents({
      'archive:astra.yaml': fileModel(analysis('Archive'))
    });
    contents.addDrive(new Drive({ name: 'archive' }));
    try {
      expect(projectDirectory('archive:astra.yaml')).toBe('archive:');
      expect(
        (await resolveProject(contents, 'archive:astra.yaml')).bundle.document
          .analysis.name
      ).toBe('Archive');
      expect(
        get.mock.calls.every(([path]) => path.startsWith('archive:'))
      ).toBe(true);
    } finally {
      contents.dispose();
    }
  });

  it('invalidates artifact snapshots when a new resolution sees modified files', async () => {
    const entries = {
      'work/astra.yaml': fileModel(
        'version: "0.0.14"\nname: Artifacts\ninputs: []\noutputs:\n  - id: plot\n    type: figure\n    format: png\n'
      ),
      'work/results/default/plot.png': fileModel('image', { size: 42 })
    };
    const { contents } = createContents(entries);
    try {
      const first = await resolveProject(contents, 'work/astra.yaml');
      expect(first.bundle.bindings[0].path).toBe('results/default/plot.png');
      expect((await resolveProject(contents, 'work/astra.yaml')).snapshot).toBe(
        first.snapshot
      );
      entries['work/results/default/plot.png'] = fileModel('image', {
        size: 42,
        last_modified: '2026-08-27T07:00:01.000Z'
      });
      const changed = await resolveProject(contents, 'work/astra.yaml');
      expect(changed.snapshot).not.toBe(first.snapshot);
      expect(changed.bundle.bindings[0].cacheToken).not.toBe(
        first.bundle.bindings[0].cacheToken
      );
    } finally {
      contents.dispose();
    }
  });

  it('rejects lexical escapes and paths that switch contents drives before reading', async () => {
    const { contents, get } = createContents({});
    contents.addDrive(new Drive({ name: 'archive' }));
    try {
      const reader = createJupyterProjectReader(contents, '');
      for (const path of [
        '../outside',
        '/outside',
        'a/../outside',
        'a\\outside',
        'archive:outside'
      ]) {
        await expect(reader.stat(path)).rejects.toBeInstanceOf(
          ProjectPathError
        );
      }
      expect(() => createJupyterProjectReader(contents, '../outside')).toThrow(
        ProjectPathError
      );
      expect(get).not.toHaveBeenCalled();
    } finally {
      contents.dispose();
    }
  });

  it('falls back to direct stat when a provider cannot list a parent', async () => {
    const { contents, get } = createContents({
      'work/value.csv': fileModel('value')
    });
    const original = get.getMockImplementation();
    get.mockImplementation(async (path, options) => {
      if (options?.type === 'directory') {
        throw { response: { status: 403 } };
      }
      return original!(path, options);
    });
    try {
      const reader = createJupyterProjectReader(contents, 'work');
      expect(await reader.stat('value.csv')).toMatchObject({ size: 5 });
      expect(await reader.stat('missing.csv')).toBeUndefined();
      await expect(reader.readDirectory('')).rejects.toEqual({
        response: { status: 403 }
      });
    } finally {
      contents.dispose();
    }
  });

  it('rejects malformed metadata and directory entries, and preserves backend failures', async () => {
    const { contents, get } = createContents({
      'work/bad.txt': fileModel('bad', { size: -1 }),
      'work/bad-dir': fileModel('', {
        type: 'directory',
        format: 'json',
        content: [{ name: '../outside', type: 'file' }]
      })
    });
    try {
      const reader = createJupyterProjectReader(contents, 'work');
      await expect(reader.stat('bad.txt')).rejects.toThrow(
        /malformed file metadata/
      );
      await expect(reader.readDirectory('bad-dir')).rejects.toThrow(
        /malformed directory entry/
      );
      get.mockRejectedValue(new Error('Connection unavailable'));
      const nextReader = createJupyterProjectReader(contents, 'work');
      await expect(nextReader.stat('nested/file')).rejects.toThrow(
        'Connection unavailable'
      );
    } finally {
      contents.dispose();
    }
  });
});
