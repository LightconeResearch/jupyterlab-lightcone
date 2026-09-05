import { ProjectPathError } from '@astra-spec/sdk';
import {
  ContentsManager,
  Drive,
  ServerConnection,
  type Contents
} from '@jupyterlab/services';
import { createJupyterProjectReader } from '../project-reader';
import { loadProject, projectErrorMessage } from '../project-data';

/** Contents models as returned by a configured provider. */
function model(values: Partial<Contents.IModel> = {}): Contents.IModel {
  return {
    name: 'astra.yaml',
    path: 'astra.yaml',
    type: 'file',
    writable: true,
    created: '2026-01-01T00:00:00Z',
    last_modified: '2026-01-01T00:00:00Z',
    mimetype: 'text/yaml',
    format: 'text',
    content: '',
    size: 12,
    ...values
  };
}

function responseError(status: number): ServerConnection.ResponseError {
  return new ServerConnection.ResponseError(
    new Response('', { status }),
    '<html>server error</html>'
  );
}

let contents: ContentsManager;
let get: jest.SpiedFunction<ContentsManager['get']>;
beforeEach(() => {
  contents = new ContentsManager();
  contents.addDrive(new Drive({ name: 'remote' }));
  get = jest.spyOn(contents, 'get');
});
afterEach(() => contents.dispose());

it.each(['', 'project', 'remote:', 'remote:project'])(
  'reads within root %s using the configured drive',
  async root => {
    get.mockResolvedValue(model({ content: 'hello' }));
    const reader = createJupyterProjectReader(contents, root);
    expect(await reader.readText('astra.yaml')).toBe('hello');
    expect(get).toHaveBeenCalledWith(contents.resolvePath(root, 'astra.yaml'), {
      content: true,
      type: 'file',
      format: 'text'
    });
  }
);

it.each([
  '../outside',
  '/outside',
  'a/../b',
  'a//b',
  'a\\b',
  'remote:outside',
  'a/./b',
  'a\0b'
])('rejects invalid path %s before any request', async path => {
  const reader = createJupyterProjectReader(contents, 'project');
  await expect(reader.readText(path)).rejects.toBeInstanceOf(ProjectPathError);
  await expect(reader.stat(path)).rejects.toBeInstanceOf(ProjectPathError);
  await expect(reader.readDirectory(path)).rejects.toBeInstanceOf(
    ProjectPathError
  );
  expect(get).not.toHaveBeenCalled();
});

it.each(['../project', 'remote:../project', 'unknown:project'])(
  'rejects invalid root %s',
  root => {
    expect(() => createJupyterProjectReader(contents, root)).toThrow(
      ProjectPathError
    );
  }
);

it('returns undefined only for a 404 stat; text and directory reads still reject', async () => {
  get.mockRejectedValue(responseError(404));
  const reader = createJupyterProjectReader(contents, '');
  expect(await reader.stat('missing')).toBeUndefined();
  await expect(reader.readText('missing')).rejects.toThrow(
    'File not found (HTTP 404): missing'
  );
  await expect(reader.readDirectory('missing')).rejects.toThrow('HTTP 404');
});

it.each([401, 403, 500])(
  'preserves failed reads (HTTP %s) without HTML',
  async status => {
    get.mockRejectedValue(responseError(status));
    const reader = createJupyterProjectReader(contents, 'project');
    await expect(reader.stat('astra.yaml')).rejects.toThrow(`HTTP ${status}`);
    await expect(reader.readText('astra.yaml')).rejects.not.toThrow('<html>');
    await expect(reader.readDirectory('')).rejects.toThrow('project');
  }
);

it('does not treat a network failure as a missing file', async () => {
  get.mockRejectedValue(new Error('offline'));
  await expect(
    createJupyterProjectReader(contents, '').stat('astra.yaml')
  ).rejects.toThrow('offline');
});

it.each([{ content: {} }, { format: 'base64' }, { type: 'directory' }])(
  'rejects malformed text %s',
  async values => {
    get.mockResolvedValue(model(values as Partial<Contents.IModel>));
    await expect(
      createJupyterProjectReader(contents, '').readText('astra.yaml')
    ).rejects.toThrow('malformed text');
  }
);

it.each([
  { size: null },
  { size: -1 },
  { size: 1.5 },
  { last_modified: 'invalid' },
  { type: 'unknown' }
])('rejects malformed metadata %s', async values => {
  get.mockResolvedValue(model(values as Partial<Contents.IModel>));
  await expect(
    createJupyterProjectReader(contents, '').stat('file')
  ).rejects.toThrow('malformed file metadata');
});

it('converts valid file metadata and directory entries', async () => {
  const reader = createJupyterProjectReader(contents, '');
  get.mockResolvedValueOnce(model());
  expect(await reader.stat('file')).toEqual({
    type: 'file',
    size: 12,
    modifiedAtMs: Date.parse('2026-01-01')
  });
  get.mockResolvedValueOnce(model({ type: 'directory' }));
  expect(await reader.stat('')).toEqual({ type: 'directory' });
  get.mockResolvedValueOnce(
    model({
      type: 'directory',
      content: [
        { name: 'child', type: 'directory' },
        { name: 'note.ipynb', type: 'notebook' }
      ]
    })
  );
  expect(await reader.readDirectory('')).toEqual([
    { name: 'child', type: 'directory' },
    { name: 'note.ipynb', type: 'file' }
  ]);
});

it.each([
  null,
  {},
  [{ name: '../escape', type: 'file' }],
  [{ name: 'a', type: 'unknown' }],
  [
    { name: 'a', type: 'file' },
    { name: 'a', type: 'file' }
  ]
])('rejects malformed listings %s', async content => {
  get.mockResolvedValue(model({ type: 'directory', content }));
  await expect(
    createJupyterProjectReader(contents, '').readDirectory('')
  ).rejects.toThrow();
});

it.each([
  'astra.yaml',
  'nested/astra.yaml',
  'remote:astra.yaml',
  'remote:nested/astra.yaml'
])('resolves and indexes a real SDK project at %s', async entrypoint => {
  get.mockImplementation(async path => {
    if (path === entrypoint) {
      return model({
        content: 'version: "0.0.14"\nname: Example\ninputs: []\noutputs: []\n'
      });
    }
    throw responseError(404);
  });
  const project = await loadProject(contents, entrypoint);
  expect(project.document.analysis.name).toBe('Example');
  expect(project.index.analysisByPath.get('$')).toBe(project.document.analysis);
  expect(project.document.universe.universeId).toBe('default');
  expect(project.bindings).toEqual([]);
  // Baseline: metadata + text for the entrypoint and one optional universes stat.
  expect(get).toHaveBeenCalledTimes(3);
});

it('presents SDK validation issues with their file location', async () => {
  get.mockImplementation(async path => {
    if (path === 'astra.yaml')
      return model({ content: 'version: "0.0.14"\nname: 42\n' });
    throw responseError(404);
  });
  try {
    await loadProject(contents, 'astra.yaml');
    throw new Error('Expected invalid project');
  } catch (error) {
    expect(projectErrorMessage(error)).toMatch(/astra.yaml/);
    expect(projectErrorMessage(error)).toMatch(/name/);
  }
});

it('keeps artifact bindings and canonical identities from the SDK', async () => {
  get.mockImplementation(async path => {
    if (path === 'nested/astra.yaml') {
      return model({
        content:
          'version: "0.0.14"\nname: Metrics\ninputs: []\noutputs:\n  - id: score\n    type: metric\n    format: json\n'
      });
    }
    if (path === 'nested/results/default/score.json') return model();
    throw responseError(404);
  });
  const project = await loadProject(contents, 'nested/astra.yaml');
  expect(project.index.recordByPath.get('outputs.score')).toBe(
    project.document.analysis.outputs[0]
  );
  expect(project.bindings).toEqual([
    {
      outputPath: 'outputs.score',
      path: 'results/default/score.json',
      cacheToken: expect.any(String)
    }
  ]);
  expect(
    get.mock.calls.filter(([, options]) => options?.content === true)
  ).toHaveLength(1);
});
