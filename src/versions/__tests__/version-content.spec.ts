import { TextDecoder } from 'node:util';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import { previewForVersion, type IVersionTarget } from '../version-content';
import { versionContentUrl, type IOutputVersion } from '../versions-api';

const settings = ServerConnection.makeSettings({
  baseUrl: 'http://localhost:8888/lab/'
});

const target: IVersionTarget = {
  settings,
  entrypoint: 'project/astra.yaml',
  universe: 'baseline',
  outputId: 'fit'
};

function output(type: string, format?: string): ResolvedOutput {
  return {
    kind: 'output',
    id: 'fit',
    canonicalPath: 'outputs.fit',
    label: 'Fit',
    type,
    format
  } as unknown as ResolvedOutput;
}

function version(extra: Partial<IOutputVersion> = {}): IOutputVersion {
  return {
    commit: 'c'.repeat(40),
    short: 'ccccccc',
    time: '2026-09-20T10:00:00Z',
    subject: 'materialize fit',
    size: 100,
    present: true,
    annex: null,
    manifest: null,
    ...extra
  };
}

/** Answer content requests with `body`, or with an HTTP error. */
function serve(body: string, status = 200): jest.SpyInstance {
  return jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(
      async () =>
        new Response(body, { status, statusText: status === 200 ? 'OK' : '' })
    );
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: TextDecoder,
    configurable: true
  });
});

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('previews of a committed version', () => {
  it('explains content git-annex keeps without a request', async () => {
    const request = serve('');
    await expect(
      previewForVersion(
        target,
        output('figure', 'png'),
        version({ present: false })
      )
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'The bytes of this version are not in this repository.'
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('points an image at the immutable content URL of its commit', async () => {
    const request = serve('');
    await expect(
      previewForVersion(target, output('figure', '.PNG'), version())
    ).resolves.toEqual({
      kind: 'image',
      url: versionContentUrl(
        settings,
        'project/astra.yaml',
        'baseline',
        'fit',
        'c'.repeat(40)
      ),
      alt: 'Fit at ccccccc'
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads a delimited table from the content route', async () => {
    const request = serve('a,b\n1,2\n');
    const preview = await previewForVersion(
      target,
      output('table', 'csv'),
      version()
    );
    expect(preview).toMatchObject({ kind: 'table' });
    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/versions/content');
    expect(url.searchParams.get('commit')).toBe('c'.repeat(40));
  });

  it('bounds, parses and checks JSON metrics', async () => {
    let request = serve('{"value": 1.5}');
    await expect(
      previewForVersion(
        target,
        output('metric', 'json'),
        version({ size: 3_000_000 })
      )
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'The JSON artifact exceeds the preview limit.'
    });
    expect(request).not.toHaveBeenCalled();
    await expect(
      previewForVersion(target, output('metric', 'json'), version())
    ).resolves.toMatchObject({ kind: 'metric' });
    request.mockRestore();
    request = serve('not json');
    await expect(
      previewForVersion(target, output('metric', 'json'), version())
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'The file is not a JSON metric.'
    });
    request.mockRestore();
    // A version whose size the listing does not know is cut at the limit
    // while it is read, and says so rather than calling itself invalid.
    request = serve(`[${'1,'.repeat(1_000_001)}1]`);
    await expect(
      previewForVersion(
        target,
        output('metric', 'json'),
        version({ size: null })
      )
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'The JSON artifact exceeds the preview limit.'
    });
    request.mockRestore();
    serve('{"reason": "absent"}', 404);
    await expect(
      previewForVersion(target, output('metric', 'json'), version())
    ).rejects.toBeInstanceOf(RequestError);
  });

  it('names formats without a bounded preview', async () => {
    await expect(
      previewForVersion(target, output('data', 'npz'), version())
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'No bounded preview is available for .npz artifacts.'
    });
    await expect(
      previewForVersion(target, output('data'), version())
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'This output does not declare an artifact format.'
    });
  });
});

test('a renamed table previews its historical delimiter', async () => {
  serve('a,b\n1,2\n');
  const preview = await previewForVersion(
    target,
    output('table', 'tsv'),
    version({ file: 'results/baseline/table.csv' })
  );
  expect(preview.kind).toBe('table');
  expect(preview).toEqual(
    await previewForVersion(target, output('table', 'csv'), version())
  );
});
