import type { JupyterFrontEnd } from '@jupyterlab/application';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { IChatPanel } from '@jupyter/chat';

/** Wait for this chat's actual agent list, rather than a provisional picker stamp. */
export async function waitForPersonas(
  registry: PersonaSessionRegistry,
  panel: IChatPanel,
  timeout = 20_000
): Promise<PersonaManagerSessionState | undefined> {
  const chatId = await panel.model.ready;
  return new Promise(resolve => {
    let state = registry.get(chatId);
    const finish = (value?: PersonaManagerSessionState) => {
      window.clearTimeout(timer);
      state.changed.disconnect(check);
      panel.disposed.disconnect(cancel);
      resolve(value);
    };
    const cancel = () => finish();
    const check = () => {
      if (panel.isDisposed) {
        finish();
        return;
      }
      if (state.isDisposed) {
        state.changed.disconnect(check);
        state = registry.get(chatId);
        state.changed.connect(check);
      }
      if (state.ready) finish(state);
    };
    const timer = window.setTimeout(cancel, timeout);
    state.changed.connect(check);
    panel.disposed.connect(cancel);
    check();
  });
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
