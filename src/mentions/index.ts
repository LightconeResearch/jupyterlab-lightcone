import {
  chatIcon,
  IChatCommandRegistry,
  type ChatCommand,
  type IChatCommandProvider,
  type IInputModel
} from '@jupyter/chat';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { Contents } from '@jupyterlab/services';
import type { ResolvedRecord } from '@astra-spec/sdk';
import type { IDisposable } from '@lumino/disposable';
import { createElement } from 'react';
import { AstraKindMark } from '../astra-kind';
import { ChatProjects } from '../comments/chat-projects';
import { isRootAnalysisOutput } from '../materialization-status';
import { projectDirectory, type ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataLease
} from '../project-data-service';
import { ISessionService } from '../sessions/session-service';
import { listVersionsCached } from '../versions/version-cache';
import {
  parseMention,
  recordMentions,
  sessionMentions,
  type IMentionCandidate
} from './mention-candidates';

export * from './mention-candidates';

/** The provider's ID in Jupyter Chat's command registry. */
export const MENTION_PROVIDER_ID = 'jupyterlab_lightcone:mentions';

/** Outputs whose newest version a single keystroke may look up. */
const VERSION_LOOKUPS = 5;

export interface IMentionProviderOptions {
  contents: Contents.IManager;
  /** Absent without Jupyter Chat's sessions. */
  sessions: ISessionService | null;
  projects?: ChatProjects;
}

/**
 * `@` mentions of ASTRA records and `#` mentions of the project's sessions in
 * the session composer. Choosing one replaces the typed word with a visible
 * reference (a record path, with an output's version; a chat file), so the
 * agent reads exactly what the user sees. Nothing is sent or attached.
 */
export class MentionProvider implements IChatCommandProvider, IDisposable {
  constructor(options: IMentionProviderOptions) {
    this._contents = options.contents;
    this._sessions = options.sessions;
    this._projects = options.projects ?? new ChatProjects(options.contents);
  }

  readonly id = MENTION_PROVIDER_ID;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  async listCommandCompletions(input: IInputModel): Promise<ChatCommand[]> {
    const mention = parseMention(input.currentWord);
    const name = input.chatContext?.name;
    if (!mention || !name) return [];
    const entrypoint = await this._projects.entrypointFor(name);
    if (!entrypoint) return [];
    let candidates: IMentionCandidate[];
    if (mention.trigger === '@') {
      const data = await this._data(entrypoint);
      if (!data) return [];
      const versions = await this._versions(
        entrypoint,
        data,
        recordMentions(data.index.recordByPath.values(), mention.query).map(
          candidate => candidate.name.slice(1)
        )
      );
      candidates = recordMentions(
        data.index.recordByPath.values(),
        mention.query,
        record => versions.get(record.canonicalPath)
      );
    } else {
      if (!this._sessions) return [];
      const sessions = await this._sessions.list(entrypoint).catch(() => []);
      candidates = sessionMentions(
        sessions,
        mention.query,
        projectDirectory(entrypoint)
      );
    }
    return candidates.map(candidate => ({
      name: candidate.name,
      providerId: this.id,
      description: candidate.description,
      replaceWith: candidate.replaceWith,
      spaceOnAccept: true,
      // Records carry the kind mark the inventory draws; sessions, a chat.
      icon: candidate.kind
        ? createElement(AstraKindMark, { kind: candidate.kind })
        : chatIcon
    }));
  }

  /** References are plain text; nothing to do when the message goes out. */
  async onSubmit(): Promise<void> {
    return;
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._lease?.lease.release();
    this._lease = null;
  }

  /** The project's data, holding one project's service between keystrokes. */
  private async _data(
    entrypoint: string
  ): Promise<ILoadedProjectData | undefined> {
    if (this._isDisposed) return undefined;
    if (this._lease?.entrypoint !== entrypoint) {
      this._lease?.lease.release();
      this._lease = {
        entrypoint,
        lease: acquireProjectDataService(this._contents, entrypoint)
      };
    }
    try {
      return await this._lease.lease.service.get();
    } catch {
      return undefined;
    }
  }

  /** Newest committed version of the first few root outputs listed. */
  private async _versions(
    entrypoint: string,
    data: ILoadedProjectData,
    paths: readonly string[]
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (this._contents.driveName(entrypoint)) return found;
    const outputs = paths
      .map(path => data.index.recordByPath.get(path))
      .filter(
        (record): record is Extract<ResolvedRecord, { kind: 'output' }> =>
          record?.kind === 'output' && isRootAnalysisOutput(data.index, record)
      )
      .slice(0, VERSION_LOOKUPS);
    const universe = data.document.universe.universeId;
    await Promise.all(
      outputs.map(output =>
        listVersionsCached(
          this._contents.serverSettings,
          entrypoint,
          universe,
          output.id
        ).then(
          listing => {
            const newest = listing.versions[0];
            if (newest) found.set(output.canonicalPath, newest.commit);
          },
          () => undefined
        )
      )
    );
    return found;
  }

  private readonly _contents: Contents.IManager;
  private readonly _sessions: ISessionService | null;
  private readonly _projects: ChatProjects;
  private _lease: { entrypoint: string; lease: IProjectDataLease } | null =
    null;
  private _isDisposed = false;
}

/** Register `@` record and `#` session mentions with Jupyter Chat's composer. */
export const mentionsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:mentions',
  description:
    'Mention ASTRA records with @ and project sessions with # in the session composer.',
  autoStart: true,
  optional: [IChatCommandRegistry, ISessionService],
  activate: (
    app: JupyterFrontEnd,
    registry: IChatCommandRegistry | null,
    sessions: ISessionService | null
  ) => {
    if (!registry) return;
    const provider = new MentionProvider({
      contents: app.serviceManager.contents,
      sessions
    });
    registry.addProvider(provider);
    app.shell.disposed.connect(() => provider.dispose());
  }
};
