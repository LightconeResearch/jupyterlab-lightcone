import { COMMIT_PATTERN } from './versions/versions-api';
import {
  parseElementReference,
  type IElementReference
} from './element-reference';

export const ASTRA_MIME_TYPE = 'application/vnd.lightcone.astra+json';

/** The committed output version a card was made from. */
export interface IAstraCardVersion {
  /** Full or abbreviated commit hash (see `COMMIT_PATTERN`). */
  commit: string;
  /** git-annex key of the bytes at that commit, when known. */
  key?: string;
}

/** Versioned references, never executable markup or snapshots of private project data. */
export interface IAstraCard extends IElementReference {
  version: 1;
  universeId: string | null;
  /** Present when the card shows an output as it was at a specific commit. */
  outputVersion?: IAstraCardVersion;
}

const KEY_MAX_LENGTH = 256;

function parseCardVersion(value: unknown): IAstraCardVersion {
  if (
    !value ||
    typeof value !== 'object' ||
    !('commit' in value) ||
    typeof value.commit !== 'string' ||
    !COMMIT_PATTERN.test(value.commit) ||
    ('key' in value &&
      value.key !== undefined &&
      (typeof value.key !== 'string' ||
        value.key.length === 0 ||
        value.key.length > KEY_MAX_LENGTH ||
        /[\s/\\]/.test(value.key)))
  )
    throw new Error('Invalid ASTRA preview card version.');
  return {
    commit: value.commit.toLowerCase(),
    ...('key' in value && typeof value.key === 'string'
      ? { key: value.key }
      : {})
  };
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
  const outputVersion =
    'outputVersion' in value && value.outputVersion !== undefined
      ? parseCardVersion(value.outputVersion)
      : undefined;
  return {
    ...reference,
    version: 1,
    universeId: value.universeId,
    ...(outputVersion ? { outputVersion } : {})
  };
}
