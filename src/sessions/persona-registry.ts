import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { PersonaSessionRegistry } from '@jupyter-ai/persona-manager';

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
