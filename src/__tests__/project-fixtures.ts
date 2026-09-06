import {
  Contents,
  ContentsManager,
  ServerConnection
} from '@jupyterlab/services';

import { deserialize, serialize } from 'node:v8';
import { webcrypto } from 'node:crypto';

// JSDOM does not expose this browser API required by the SDK's schema validator.
globalThis.structuredClone ??= <T>(value: T): T =>
  deserialize(serialize(value));
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

/** Minimal valid project, leaving schema semantics to the real SDK. */
export function analysis(name: string): string {
  return `version: "0.0.14"\nname: ${name}\ninputs: []\noutputs: []\n`;
}

export function fileModel(
  content: string,
  overrides: Partial<Contents.IModel> = {}
): Omit<Contents.IModel, 'content'> & { content: unknown } {
  return {
    name: '',
    path: '',
    type: 'file',
    writable: true,
    created: '2026-08-27T07:00:00.000Z',
    last_modified: '2026-08-27T07:00:00.000Z',
    mimetype: 'text/plain',
    format: 'text',
    size: content.length,
    content,
    ...overrides
  };
}

/** Use real Jupyter path/drive handling with an in-memory contents transport. */
export function createContents(entries: Record<string, Contents.IModel>): {
  contents: ContentsManager;
  get: jest.SpiedFunction<ContentsManager['get']>;
} {
  const contents = new ContentsManager();
  const get = jest
    .spyOn(contents, 'get')
    .mockImplementation(async (path, options) => {
      let model = entries[path];
      if (!model) {
        const prefix = path ? `${path}${path.endsWith(':') ? '' : '/'}` : '';
        const children = new Map<string, Contents.IModel>();
        for (const [key, value] of Object.entries(entries)) {
          if (!key.startsWith(prefix)) {
            continue;
          }
          const suffix = key.slice(prefix.length);
          const name = suffix.split('/')[0];
          children.set(name, {
            ...value,
            name,
            type: suffix.includes('/') ? 'directory' : value.type
          });
        }
        if (!children.size) {
          throw new ServerConnection.ResponseError(
            new Response('', { status: 404 })
          );
        }
        model = fileModel('', {
          type: 'directory',
          format: 'json',
          content: Array.from(children.values())
        });
      }
      return {
        ...model,
        path,
        name: path.split('/').pop() ?? '',
        content: options?.content === false ? null : model.content,
        format: options?.content === false ? null : model.format
      };
    });
  return { contents, get };
}
