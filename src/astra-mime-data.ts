import {
  parseElementReference,
  type IElementReference
} from './element-reference';

export const ASTRA_MIME_TYPE = 'application/vnd.lightcone.astra+json';

/** Versioned references, never executable markup or snapshots of private project data. */
export interface IAstraCard extends IElementReference {
  version: 1;
  universeId: string | null;
}

/** Treat saved MIME data as untrusted, including its project and universe. */
export function parseAstraCard(value: unknown): IAstraCard {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('entrypoint' in value) ||
    typeof value.entrypoint !== 'string' ||
    !('target' in value) ||
    typeof value.target !== 'string' ||
    !('universeId' in value) ||
    (value.universeId !== null && typeof value.universeId !== 'string') ||
    'doi' in value
  )
    throw new Error('Invalid or unsupported ASTRA preview card.');
  const reference = parseElementReference({
    entrypoint: value.entrypoint,
    target: value.target,
    universeId: value.universeId
  });
  return { ...reference, version: 1, universeId: value.universeId };
}
