import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { tablePreviewFromDelimited } from '@astra-spec/ui/lib';
import { ContentsManager, Drive } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import type { ResolvedOutput } from '@astra-spec/sdk';
import { JupyterArtifactAccess, readBoundedText } from '../artifact-access';

describe('opening artifacts', () => {
  it.each(['work/astra.yaml', 'archive:work/astra.yaml'])(
    'opens the bound file through the document command for %s',
    async entrypoint => {
      const contents = new ContentsManager();
      contents.addDrive(new Drive({ name: 'archive' }));
      const commands = new CommandRegistry();
      const open = jest.fn();
      commands.addCommand('docmanager:open', { execute: open });
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
        commands
      );
      try {
        await access.open(output);
        expect(open).toHaveBeenCalledWith({
          path: `${entrypoint.startsWith('archive:') ? 'archive:' : ''}work/results/alternate/checks/fit plot.png`
        });
        expect(download).not.toHaveBeenCalled();
        await expect(
          access.open({ canonicalPath: 'outputs.missing' } as ResolvedOutput)
        ).rejects.toThrow('not materialized');
        expect(open).toHaveBeenCalledTimes(1);
      } finally {
        contents.dispose();
      }
    }
  );
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
