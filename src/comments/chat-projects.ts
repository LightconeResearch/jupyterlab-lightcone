import type { Contents } from '@jupyterlab/services';
import { findProjectRoot } from '../project-root';

/** The directory of a Contents path, keeping its drive prefix. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? path.slice(0, path.indexOf(':') + 1)
    : path.slice(0, slash);
}

/** How long "no project" answers are trusted before looking again, in ms. */
const MISS_TTL = 30_000;

/**
 * The project owning each chat file, looked up once per path. Chats live
 * under `<project>/chats/`, so the nearest `astra.yaml` above the file is
 * the project whose comments travel with the chat's messages.
 */
export class ChatProjects {
  constructor(private contents: Contents.IManager) {}

  /** The entrypoint of the project owning a file, or null outside projects. */
  entrypointFor(path: string): Promise<string | null> {
    const key = this.contents.normalize(path);
    const cached = this._cache.get(key);
    if (cached && (cached.hit || Date.now() - cached.time < MISS_TTL)) {
      return cached.promise;
    }
    const entry = {
      time: Date.now(),
      hit: false,
      promise: Promise.resolve<string | null>(null)
    };
    entry.promise = findProjectRoot(this.contents, directoryOf(key))
      .then(root => {
        entry.hit = !!root;
        return root?.entrypoint ?? null;
      })
      .catch(error => {
        console.warn('Could not find the project owning a chat.', error);
        return null;
      });
    this._cache.set(key, entry);
    return entry.promise;
  }

  private _cache = new Map<
    string,
    { time: number; hit: boolean; promise: Promise<string | null> }
  >();
}
