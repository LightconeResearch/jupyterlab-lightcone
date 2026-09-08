import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { tablePreviewFromDelimited } from '@astra-spec/ui/lib';
import { readBoundedText } from '../artifact-access';

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
