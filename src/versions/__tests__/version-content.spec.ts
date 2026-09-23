import { TextDecoder } from 'node:util';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import {
  compareModeFor,
  previewForVersion,
  readVersionTableShape,
  type IVersionTarget
} from '../version-content';
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
    subject: '[DATALAD RUNCMD] fit [baseline]',
    key: null,
    size: 100,
    present: true,
    run: null,
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
  it('explains content that is not available locally without a request', async () => {
    const request = serve('');
    await expect(
      previewForVersion(
        target,
        output('figure', 'png'),
        version({ present: false })
      )
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Content not available locally'
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
    ).rejects.toThrow('The JSON artifact exceeds the preview limit.');
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

describe('comparisons', () => {
  it('compares figures as images, metrics by value and tables by shape', () => {
    expect(compareModeFor(output('figure', 'png'))).toBe('image');
    expect(compareModeFor(output('metric', 'json'))).toBe('metric');
    expect(compareModeFor(output('table', 'json'))).toBe('table');
    expect(compareModeFor(output('table', 'tsv'))).toBe('table');
    expect(compareModeFor(output('data', 'npz'))).toBe('none');
    expect(compareModeFor(output('figure', 'pdf'))).toBe('none');
  });

  it('reads the shape of delimited and JSON tables', async () => {
    let request = serve('a,b\n1,2\n3,4\n');
    await expect(
      readVersionTableShape(target, 'c'.repeat(40), 'csv')
    ).resolves.toEqual({ headers: ['a', 'b'], rows: 2, truncated: false });
    request.mockRestore();
    request = serve('[{"z": 0.1, "mu": 35}, {"z": 0.2, "mu": 36}]');
    await expect(
      readVersionTableShape(target, 'c'.repeat(40), 'json')
    ).resolves.toEqual({ headers: ['z', 'mu'], rows: 2, truncated: false });
    request.mockRestore();
    serve('{"value": 1}');
    await expect(
      readVersionTableShape(target, 'c'.repeat(40), 'json')
    ).rejects.toThrow('not a JSON table');
    await expect(
      readVersionTableShape(target, 'c'.repeat(40), 'npz')
    ).rejects.toThrow('.npz');
  });

  it('marks a delimited table cut at the shape limit as truncated', async () => {
    const row = '1,2\n';
    serve(`a,b\n${row.repeat(1_100_000)}`);
    const shape = await readVersionTableShape(target, 'c'.repeat(40), 'csv');
    expect(shape.truncated).toBe(true);
    expect(shape.rows).toBeGreaterThan(900_000);
    expect(shape.rows).toBeLessThan(1_100_000);
  });
});
