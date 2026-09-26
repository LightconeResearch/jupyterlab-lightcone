import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { tablePreviewFromDelimited } from '@astra-spec/ui/lib';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import { ContentsManager, Drive, ServerConnection } from '@jupyterlab/services';
import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  JupyterArtifactAccess,
  readBoundedText,
  type IDocumentOpener
} from '../artifact-access';

/** A document manager that records what it was asked to open. */
function opener(): IDocumentOpener & { openOrReveal: jest.Mock } {
  // Only whether a viewer opened matters here, not the widget itself.
  const opened = { id: 'opened' } as unknown as IDocumentWidget;
  return { openOrReveal: jest.fn(() => opened) };
}

describe('opening artifacts', () => {
  it.each(['work/astra.yaml', 'archive:work/astra.yaml'])(
    'opens the bound file through the document manager for %s',
    async entrypoint => {
      const contents = new ContentsManager();
      contents.addDrive(new Drive({ name: 'archive' }));
      const documents = opener();
      const download = jest.spyOn(contents, 'getDownloadUrl');
      const output = { canonicalPath: 'checks.outputs.fit' } as ResolvedOutput;
      const access = new JupyterArtifactAccess(
        contents,
        entrypoint,
        [
          {
            outputPath: output.canonicalPath,
            path: 'results/alternate/checks/fit plot.png',
            cacheToken: 'version'
          }
        ],
        documents
      );
      try {
        await access.open(output);
        expect(documents.openOrReveal).toHaveBeenCalledWith(
          `${entrypoint.startsWith('archive:') ? 'archive:' : ''}work/results/alternate/checks/fit plot.png`,
          undefined
        );
        expect(download).not.toHaveBeenCalled();
        await expect(
          access.open({ canonicalPath: 'outputs.missing' } as ResolvedOutput)
        ).rejects.toThrow('not materialized');
        expect(documents.openOrReveal).toHaveBeenCalledTimes(1);
        await access.openPath('src/fit.py', 'Editor');
        expect(documents.openOrReveal).toHaveBeenLastCalledWith(
          `${entrypoint.startsWith('archive:') ? 'archive:' : ''}work/src/fit.py`,
          'Editor'
        );
      } finally {
        contents.dispose();
      }
    }
  );

  it('reports a file no document viewer opens', async () => {
    const contents = new ContentsManager();
    const documents = opener();
    documents.openOrReveal.mockReturnValue(undefined);
    const access = new JupyterArtifactAccess(
      contents,
      'astra.yaml',
      [],
      documents
    );
    try {
      await expect(access.openPath('notes.bin')).rejects.toThrow(
        'No document viewer can open notes.bin.'
      );
    } finally {
      contents.dispose();
    }
  });
});

describe('previewing the current artifact', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'TextDecoder', {
      value: TextDecoder,
      configurable: true
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const output = {
    id: 'fit',
    canonicalPath: 'outputs.fit',
    kind: 'output',
    type: 'table',
    format: 'csv',
    artifact: { byteSize: 1_000_000 }
  } as unknown as ResolvedOutput;

  function access(contents: ContentsManager): JupyterArtifactAccess {
    return new JupyterArtifactAccess(
      contents,
      'work/astra.yaml',
      [
        {
          outputPath: output.canonicalPath,
          path: 'results/fit.csv',
          cacheToken: 'token'
        }
      ],
      opener()
    );
  }

  it('asks for a byte range and marks a partial table as truncated', async () => {
    const contents = new ContentsManager();
    const request = jest
      .spyOn(ServerConnection, 'makeRequest')
      .mockResolvedValue(new Response('a,b\n1,2\n', { status: 206 }));
    try {
      const preview = await access(contents).getPreview(output);
      expect(preview).toMatchObject({
        kind: 'table',
        headers: ['a', 'b'],
        truncated: true
      });
      const [url, init] = request.mock.calls[0];
      expect(url).toContain('astra-cache-token=token');
      expect(init.headers).toEqual({ Range: 'bytes=0-65535' });
    } finally {
      contents.dispose();
    }
  });

  it('explains an output without an artifact instead of requesting it', async () => {
    const contents = new ContentsManager();
    const request = jest.spyOn(ServerConnection, 'makeRequest');
    try {
      await expect(
        access(contents).getPreview({
          ...output,
          artifact: undefined
        } as unknown as ResolvedOutput)
      ).resolves.toEqual({
        kind: 'unavailable',
        reason: 'This output has not been materialized.'
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      contents.dispose();
    }
  });
});

describe('bounded artifact reading', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'ReadableStream', {
      value: NodeReadableStream,
      configurable: true
    });
    Object.defineProperty(globalThis, 'TextDecoder', {
      value: TextDecoder,
      configurable: true
    });
  });
  it('cancels an oversized response when a server ignores the Range header', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('0123456789'.repeat(1000)));
      },
      cancel
    });
    await expect(readBoundedText({ body }, 5)).resolves.toEqual({
      text: '01234',
      truncated: true
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('decodes characters split between streamed chunks', async () => {
    const encoded = new TextEncoder().encode('résultats');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 2));
        controller.enqueue(encoded.subarray(2));
        controller.close();
      }
    });
    await expect(readBoundedText({ body }, 100)).resolves.toEqual({
      text: 'résultats',
      truncated: false
    });
  });

  it('drops a quoted CSV record cut off at the byte limit', async () => {
    const input = 'name,value\ncomplete,1\n"incomplete\nquoted record",2';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      }
    });
    const sample = await readBoundedText({ body }, input.indexOf('quoted'));
    expect(
      tablePreviewFromDelimited(sample.text, {
        sourceTruncated: sample.truncated
      })
    ).toMatchObject({
      headers: ['name', 'value'],
      rows: [['complete', '1']],
      truncated: true
    });
  });

  it('releases the stream lock after a failed download', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('Download interrupted'));
      }
    });
    await expect(readBoundedText({ body }, 100)).rejects.toThrow(
      'Download interrupted'
    );
    expect(body.locked).toBe(false);
  });
});
