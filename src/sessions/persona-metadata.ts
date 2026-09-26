import { isRecord } from '../api';

/**
 * Whether input metadata carries the persona picker's stamp, which always
 * includes `to_persona` (null for "No one").
 */
export function isComposerStamp(metadata: unknown): boolean {
  return isRecord(metadata) && 'to_persona' in metadata;
}

/** The persona the composer would stamp on the next message, if it chose one. */
export function selectedPersona(metadata: unknown): string | null {
  return isRecord(metadata) &&
    typeof metadata.to_persona === 'string' &&
    metadata.to_persona
    ? metadata.to_persona
    : null;
}

/**
 * The metadata the persona picker stamps for a persona with every control at
 * its default, so a message addressed by the workbench reads like one sent
 * from the composer. It restates `buildMessageMetadata(personaId,
 * emptyPersonaSettings())` of `@jupyter-ai/persona-manager/lib/metadata`,
 * which the package does not export; keep the two in step.
 */
export function personaMetadata(personaId: string): Record<string, unknown> {
  return {
    to_persona: personaId,
    model: { id: null, settings: {} },
    settings: {}
  };
}
