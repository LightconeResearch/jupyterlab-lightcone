import type { JupyterFrontEnd } from '@jupyterlab/application';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { IChatPanel } from '@jupyter/chat';
import type { ISignal } from '@lumino/signaling';

/** How long a chat's persona list may take to arrive before the chat is left as it is. */
export const PERSONAS_TIMEOUT = 20_000;

/**
 * Wait until the chat's persona state is `accepted`, following the registry
 * when it replaces the chat's state (it discards it when a view of the chat
 * closes). Resolves with the accepted state, or undefined once the list has
 * arrived without being accepted, after the timeout, or once `cancelled`
 * says so: on any change, and at once when `cancel` fires.
 */
export function whenPersonas(
  registry: PersonaSessionRegistry,
  chatId: string,
  accepted: (state: PersonaManagerSessionState) => boolean,
  cancelled: () => boolean,
  timeout = PERSONAS_TIMEOUT,
  cancel?: ISignal<unknown, unknown>
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
      cancel?.disconnect(check);
      resolve(value);
    };
    function check(): void {
      if (cancelled()) {
        finish(undefined);
      } else if (state?.isDisposed) {
        listen();
        check();
      } else if (state && accepted(state)) {
        finish(state);
      } else if (state?.ready) {
        finish(undefined);
      }
    }
    timer = window.setTimeout(() => finish(undefined), timeout);
    cancel?.connect(check);
    listen();
    check();
  });
}

/** Wait for this chat's actual agent list, rather than a provisional picker stamp. */
export async function waitForPersonas(
  registry: PersonaSessionRegistry,
  panel: IChatPanel
): Promise<PersonaManagerSessionState | undefined> {
  const chatId = await panel.model.ready;
  return whenPersonas(
    registry,
    chatId,
    state => state.ready,
    () => panel.isDisposed,
    PERSONAS_TIMEOUT,
    panel.disposed
  );
}

/**
 * Jupyter AI's persona session registry, when the persona manager is
 * installed; null otherwise. The package is a federated singleton the
 * workbench does not bundle, so it is imported lazily: a Lab without Jupyter
 * AI still loads the sessions.
 */
export async function resolvePersonaRegistry(
  app: JupyterFrontEnd
): Promise<PersonaSessionRegistry | null> {
  try {
    const { IPersonaSessionRegistry } =
      await import('@jupyter-ai/persona-manager');
    return await app.resolveOptionalService(IPersonaSessionRegistry);
  } catch (error) {
    console.warn("Jupyter AI's persona manager is unavailable.", error);
    return null;
  }
}

/**
 * Select `persona` in the chat's Jupyter AI agent picker.
 *
 * The persona manager exposes no selection API: the picker keeps its choice
 * in React state and starts every new view from the server's default. Its
 * one observable rule, `reconcileSelection` in
 * `@jupyter-ai/persona-manager/lib/persona-controls`, selects a chat's only
 * persona in a view nobody has picked in yet. Listing that persona alone,
 * then the full list again, applies that rule; the full list keeps the
 * choice, since a selection that is in the list stands. A view where the
 * user already picked is left alone by the picker itself.
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
