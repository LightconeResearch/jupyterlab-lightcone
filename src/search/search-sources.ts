import { chatIcon } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { fileIcon } from '@jupyterlab/ui-components';
import { acquireProjectDataService } from '../project-data-service';
import type { IProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';
import { walkProjectFiles, type IProjectFile } from './project-files';
import {
  commandCandidates,
  fileCandidates,
  recordCandidates,
  sessionCandidates,
  type ISearchCandidate
} from './search-candidates';

/** How long a project's file listing is reused between openings. */
export const FILE_LISTING_TTL = 30000;

interface IFileListing {
  at: number;
  files: IProjectFile[];
}

/**
 * Loads each candidate group from the workbench: the session service, the
 * shared project data service, a bounded Contents walk and the command
 * registry. Only the file walk is cached, since it costs one request per folder.
 */
export class SearchSources {
  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly sessions: ISessionService | null,
    private readonly excludedCommands: readonly string[]
  ) {}

  /** Whether the sessions group can be offered at all. */
  get hasSessions(): boolean {
    return this.sessions !== null;
  }

  listCommands(): Promise<ISearchCandidate[]> {
    return commandCandidates(this.app.commands, {
      exclude: this.excludedCommands
    });
  }

  async listSessions(project: IProjectRoot): Promise<ISearchCandidate[]> {
    if (!this.sessions) {
      return [];
    }
    const sessions = await this.sessions.list(project.entrypoint);
    return sessionCandidates(sessions, { icon: chatIcon });
  }

  async listRecords(project: IProjectRoot): Promise<ISearchCandidate[]> {
    const lease = acquireProjectDataService(
      this.app.serviceManager.contents,
      project.entrypoint
    );
    try {
      const data = await lease.service.get();
      return recordCandidates(data, project.entrypoint);
    } finally {
      lease.release();
    }
  }

  async listFiles(project: IProjectRoot): Promise<ISearchCandidate[]> {
    const files = await this._files(project);
    const registry = this.app.docRegistry;
    return fileCandidates(
      files,
      path => registry.getFileTypesForPath(path)[0]?.icon ?? fileIcon
    );
  }

  private _files(project: IProjectRoot): Promise<IProjectFile[]> {
    const key = project.path;
    const cached = this._listings.get(key);
    if (cached && Date.now() - cached.at < FILE_LISTING_TTL) {
      return Promise.resolve(cached.files);
    }
    let pending = this._pending.get(key);
    if (!pending) {
      pending = walkProjectFiles(this.app.serviceManager.contents, project.path)
        .then(files => {
          this._listings.set(key, { at: Date.now(), files });
          return files;
        })
        .finally(() => {
          this._pending.delete(key);
        });
      this._pending.set(key, pending);
    }
    return pending;
  }

  private readonly _listings = new Map<string, IFileListing>();
  private readonly _pending = new Map<string, Promise<IProjectFile[]>>();
}
