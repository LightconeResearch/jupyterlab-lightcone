import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IChatTracker, type IChatModel } from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { Contents } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';
import {
  createChatProjectResolver,
  recordedChatProject,
  type IChatProjectResolver
} from '../chat-links/chat-project';
import { ICurrentProject } from '../current-project';
import { isChatPanel, selectedPersona } from './session-manager';
import { fetchProjectAgent } from './sessions-api';

/** How long a chat's persona list may take to arrive before the chat is left as it is. */
export const PERSONAS_TIMEOUT = 20_000;

/** Every Jupyter AI persona's sender username starts with this. */
const PERSONA_PREFIX = 'jupyter-ai-personas';

/**
 * The persona the chat's own messages last named: the `to_persona` of its
 * newest message written by someone other than a persona.
 */
export function lastAddressedPersona(
  messages: IChatModel['messages']
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.sender?.username?.startsWith(PERSONA_PREFIX)) {
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
 * Wait until the chat's persona list names `persona`, following the registry
 * when it replaces the chat's state (it discards it when a view of the chat
 * closes). Resolves with the state that lists it, or undefined after the
 * timeout or once `cancelled` says so.
 */
export function whenListed(
  registry: PersonaSessionRegistry,
  chatId: string,
  persona: string,
  cancelled: () => boolean,
  timeout = PERSONAS_TIMEOUT
): Promise<PersonaManagerSessionState | undefined> {
  return new Promise(resolve => {
    let state: PersonaManagerSessionState | undefined;
    let timer = 0;
    const listen = () => {
      state?.changed.disconnect(check);
      state = registry.get(chatId);
      state.changed.connect(check);
    };
    const finish = (value: PersonaManagerSessionState | undefined) => {
      window.clearTimeout(timer);
      state?.changed.disconnect(check);
      resolve(value);
    };
    function check(): void {
      if (cancelled()) {
        finish(undefined);
      } else if (state?.isDisposed) {
        listen();
        check();
      } else if (state?.personas.some(option => option.id === persona)) {
        finish(state);
      }
    }
    timer = window.setTimeout(() => finish(undefined), timeout);
    listen();
    check();
  });
}

/**
 * Select `persona` in the chat's Jupyter AI agent picker. The picker keeps
 * its choice to itself and starts every new view from the server's default;
 * its one public rule is that a view nobody has picked in yet selects a
 * chat's only persona. Listing that persona alone, then the full list again,
 * applies that rule; the full list keeps the choice. A view where the user
 * already picked is left alone by the picker itself.
 */
export function selectPersona(
  state: PersonaManagerSessionState,
  persona: string
): void {
  const all = state.personas;
  const only = all.filter(option => option.id === persona);
  if (!only.length) {
    return;
  }
  state.updatePersonas(only);
  state.updatePersonas(all);
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
  async preselect(panel: Widget): Promise<void> {
    if (!isChatPanel(panel)) {
      return;
    }
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
    // Let the picker settle on the list first, then compare with its choice.
    await new Promise(resolve => window.setTimeout(resolve, 0));
    if (
      !state ||
      gone() ||
      state.isDisposed ||
      selectedPersona(model.input.getMetadata()) === wanted ||
      this._openElsewhere(panel, chatId)
    ) {
      return;
    }
    selectPersona(state, wanted);
  }

  private _onAdded(_tracker: IChatTracker, panel: Widget): void {
    void this.preselect(panel).catch(error => {
      console.warn('Could not preselect the chat agent.', error);
    });
  }

  /** The persona the chat's project last used, when the server knows one. */
  private async _projectAgent(model: IChatModel): Promise<string | undefined> {
    const { contents, projects } = this._options;
    const project = await projects.resolve(
      contents.localPath(model.name),
      recordedChatProject(model)
    );
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
  private _openElsewhere(panel: Widget, chatId: string): boolean {
    return (
      this._options.tracker.find(
        other =>
          other !== panel &&
          !other.isDisposed &&
          isChatPanel(other) &&
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
 * nothing, and its module is imported lazily so that a Lab without it still
 * loads the workbench.
 */
export const agentContinuityPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:agent-continuity',
  description:
    'Open every chat with the agent it, or its project, last used, wherever it opens.',
  autoStart: true,
  requires: [IChatTracker],
  optional: [ICurrentProject],
  activate: async (
    app: JupyterFrontEnd,
    tracker: IChatTracker,
    current: ICurrentProject | null
  ): Promise<void> => {
    let registry: PersonaSessionRegistry | null = null;
    try {
      const { IPersonaSessionRegistry } =
        await import('@jupyter-ai/persona-manager');
      registry = await app.resolveOptionalService(IPersonaSessionRegistry);
    } catch (error) {
      console.warn(
        "Jupyter AI's persona manager is unavailable; chats keep its default agent.",
        error
      );
    }
    if (!registry) {
      return;
    }
    const contents = app.serviceManager.contents;
    new AgentContinuity({
      tracker,
      registry,
      contents,
      projects: createChatProjectResolver(
        contents,
        () => current?.project ?? null
      )
    });
  }
};
