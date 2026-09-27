import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IChatTracker, type IChatModel, type IChatPanel } from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { Contents } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { IChatProjectResolver } from '../chat-links/chat-project';
import {
  PERSONAS_TIMEOUT,
  resolvePersonaRegistry,
  selectComposerPersona,
  whenPersonas
} from './persona-registry';
import { isPersonaUser } from './session-activity';
import { selectedPersona } from './persona-metadata';
import { fetchProjectAgent } from './sessions-api';

/**
 * The persona the chat's own messages last named: the `to_persona` of its
 * newest message written by someone other than a persona.
 */
export function lastAddressedPersona(
  messages: IChatModel['messages']
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isPersonaUser(message.sender)) {
      continue;
    }
    const named = selectedPersona(message.metadata);
    if (named) {
      return named;
    }
  }
  return undefined;
}

/**
 * Wait until the chat's persona list names `persona` (see `whenPersonas`).
 * Resolves with the state that lists it, or undefined once the list has
 * arrived without the persona, after the timeout, or once `cancelled` says so.
 */
export function whenListed(
  registry: PersonaSessionRegistry,
  chatId: string,
  persona: string,
  cancelled: () => boolean,
  timeout = PERSONAS_TIMEOUT
): Promise<PersonaManagerSessionState | undefined> {
  return whenPersonas(
    registry,
    chatId,
    state => state.personas.some(option => option.id === persona),
    cancelled,
    timeout
  );
}

export interface IAgentContinuityOptions {
  tracker: IChatTracker;
  registry: PersonaSessionRegistry;
  contents: Contents.IManager;
  projects: IChatProjectResolver;
}

/**
 * Open every chat with the agent it last used, else the one its project
 * last used (`agent_defaults.py` on the server), wherever the chat opens:
 * the main area, the side panel, after a move between them, a reopen or a
 * reload. Jupyter AI's picker would otherwise start each of these views from
 * the server's default, often "No one".
 */
export class AgentContinuity implements IDisposable {
  constructor(private readonly _options: IAgentContinuityOptions) {
    _options.tracker.widgetAdded.connect(this._onAdded, this);
    // Optional service loading may finish after layout restoration has
    // already added chat views to the tracker.
    _options.tracker.forEach(panel => this._onAdded(_options.tracker, panel));
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._options.tracker.widgetAdded.disconnect(this._onAdded, this);
  }

  /** Preselect the agent of a chat view that just opened; done once per view. */
  async preselect(panel: IChatPanel): Promise<void> {
    const model = panel.model;
    const gone = () => this._isDisposed || panel.isDisposed || model.isDisposed;
    const chatId = await model.ready;
    if (gone()) {
      return;
    }
    const wanted =
      lastAddressedPersona(model.messages) ?? (await this._projectAgent(model));
    if (!wanted || gone()) {
      return;
    }
    const state = await whenListed(
      this._options.registry,
      chatId,
      wanted,
      gone
    );
    // A picker that already shows the agent needs nothing; `selectPersona`
    // would be a no-op anyway, so a stamp it has not written yet costs one.
    if (
      !state ||
      gone() ||
      state.isDisposed ||
      selectedPersona(model.input.getMetadata()) === wanted ||
      this._openElsewhere(panel, chatId)
    ) {
      return;
    }
    await selectComposerPersona(panel, state, wanted, gone);
  }

  private _onAdded(_tracker: IChatTracker, panel: IChatPanel): void {
    void this.preselect(panel).catch(error => {
      console.warn('Could not preselect the chat agent.', error);
    });
  }

  /** The persona the chat's project last used, when the server knows one. */
  private async _projectAgent(model: IChatModel): Promise<string | undefined> {
    const { contents, projects } = this._options;
    const project = await projects.resolve(contents.localPath(model.name));
    if (!project) {
      return undefined;
    }
    return (
      (await fetchProjectAgent(contents.serverSettings, project.entrypoint)) ??
      undefined
    );
  }

  /**
   * Whether another live view shows the same chat. The persona list is
   * shared by a chat's views, so listing one persona there would reset a
   * choice the user made in the other view.
   */
  private _openElsewhere(panel: IChatPanel, chatId: string): boolean {
    return (
      this._options.tracker.find(
        other =>
          other !== panel &&
          !other.isDisposed &&
          !other.model.isDisposed &&
          other.model.id === chatId
      ) !== undefined
    );
  }

  private _isDisposed = false;
}

/**
 * Opens every chat with the agent it, or its project, last used. Jupyter AI's
 * persona manager provides the persona lists; without it the plugin does
 * nothing.
 */
export const agentContinuityPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:agent-continuity',
  description:
    'Open every chat with the agent it, or its project, last used, wherever it opens.',
  autoStart: true,
  requires: [IChatTracker, IChatProjectResolver],
  activate: async (
    app: JupyterFrontEnd,
    tracker: IChatTracker,
    projects: IChatProjectResolver
  ): Promise<void> => {
    const registry = await resolvePersonaRegistry(app);
    if (!registry) {
      return;
    }
    const continuity = new AgentContinuity({
      tracker,
      registry,
      contents: app.serviceManager.contents,
      projects
    });
    app.shell.disposed.connect(() => continuity.dispose());
  }
};
