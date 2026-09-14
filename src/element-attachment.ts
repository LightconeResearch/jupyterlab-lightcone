import type { IChatContext } from './chat-context';
import type { IAttachment } from '@jupyter/chat';
import type { ResolvedRecord } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import { ServerConnection, type Contents } from '@jupyterlab/services';
import {
  parseElementReference,
  resolveReference,
  type IElementReference
} from './element-reference';
import type { ILoadedProjectData } from './project-data';
import { projectDirectory } from './project-data';

export const ELEMENT_ATTACHMENT_MIME =
  'application/vnd.lightcone.element-snapshot+json';

export interface IElementSnapshot {
  schema: 'lightcone-element-snapshot.v1';
  reference: IElementReference & { universeId: string | null };
  record: ResolvedRecord;
  relatedRecords: ResolvedRecord[];
  artifacts: ILoadedProjectData['bindings'];
}

/** Freeze the selected record and its immediate scientific context, not the whole project. */
export function elementSnapshot(
  data: ILoadedProjectData,
  reference: IElementReference
): IElementSnapshot {
  const { record } = resolveReference(data, reference);
  if (!record)
    throw new Error('Choose a decision, finding, input, or output to attach.');
  const paths =
    record.kind === 'decision'
      ? record.options.flatMap(option => option.resolvedInsightPaths)
      : record.kind === 'finding' || record.kind === 'prior_insight'
        ? record.evidence.flatMap(evidence =>
            evidence.resolvedOutputPath ? [evidence.resolvedOutputPath] : []
          )
        : record.kind === 'output'
          ? [
              ...record.provenance.inputPaths,
              ...record.provenance.decisionPaths
            ]
          : record.kind === 'input' && record.resolvedFrom
            ? [record.resolvedFrom]
            : [];
  const relatedRecords = [...new Set(paths)].flatMap(path => {
    const related = data.index.recordByPath.get(path);
    return related ? [related] : [];
  });
  const outputPaths = new Set(
    [record, ...relatedRecords]
      .filter(item => item.kind === 'output')
      .map(item => item.canonicalPath)
  );
  // JSON round-trip prevents subsequent host edits from mutating this snapshot.
  return JSON.parse(
    JSON.stringify({
      schema: 'lightcone-element-snapshot.v1',
      reference: {
        entrypoint: reference.entrypoint,
        target: record.canonicalPath,
        universeId:
          data.document.universe.source === 'none'
            ? null
            : data.document.universe.universeId
      },
      record,
      relatedRecords,
      artifacts: data.bindings.filter(binding =>
        outputPaths.has(binding.outputPath)
      )
    })
  );
}

async function digest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content)
  );
  return Array.from(new Uint8Array(bytes), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function missing(error: unknown): boolean {
  return (
    error instanceof ServerConnection.ResponseError &&
    error.response.status === 404
  );
}

async function ensureDirectory(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  try {
    const existing = await contents.get(path, { content: false });
    if (existing.type !== 'directory')
      throw new Error(`Attachment directory is a file: ${path}`);
  } catch (error) {
    if (!missing(error)) throw error;
    await contents.save(path, { type: 'directory' });
  }
}

/** Native file attachments persist in .chat and are readable by existing agent providers. */
export async function saveElementAttachment(
  contents: Contents.IManager,
  snapshot: IElementSnapshot
): Promise<IAttachment> {
  const content = JSON.stringify(snapshot, null, 2);
  const hash = await digest(content);
  const folder = PathExt.join(
    projectDirectory(snapshot.reference.entrypoint),
    'chat-attachments'
  );
  const revision = PathExt.join(folder, hash);
  const path = PathExt.join(revision, `${snapshot.reference.target}.json`);
  await ensureDirectory(contents, folder);
  await ensureDirectory(contents, revision);
  try {
    const existing = await contents.get(path, {
      content: true,
      format: 'text'
    });
    if (existing.content !== content)
      throw new Error(
        'The saved element snapshot has changed. Restore it before reattaching.'
      );
  } catch (error) {
    if (!missing(error)) throw error;
    await contents.save(path, {
      type: 'file',
      format: 'text',
      mimetype: 'application/json',
      content
    });
  }
  return { type: 'file', value: path, mimetype: ELEMENT_ATTACHMENT_MIME };
}

export function isElementAttachment(attachment: IAttachment): boolean {
  return (
    attachment.type === 'file' &&
    attachment.mimetype === ELEMENT_ATTACHMENT_MIME
  );
}

/** Check persisted data and its content address before using a saved navigation target. */
export async function readElementAttachment(
  contents: Contents.IManager,
  attachment: IAttachment
): Promise<IElementSnapshot> {
  if (!isElementAttachment(attachment))
    throw new Error('Not an ASTRA element attachment.');
  const file = await contents.get(attachment.value, {
    content: true,
    format: 'text'
  });
  if (typeof file.content !== 'string')
    throw new Error('Invalid element snapshot.');
  const value: unknown = JSON.parse(file.content);
  if (
    !value ||
    typeof value !== 'object' ||
    !('schema' in value) ||
    value.schema !== 'lightcone-element-snapshot.v1' ||
    !('reference' in value) ||
    !value.reference ||
    typeof value.reference !== 'object' ||
    !('record' in value) ||
    !value.record ||
    typeof value.record !== 'object'
  )
    throw new Error('Invalid element snapshot.');
  const raw = value.reference;
  if (
    !('entrypoint' in raw) ||
    typeof raw.entrypoint !== 'string' ||
    !('target' in raw) ||
    typeof raw.target !== 'string' ||
    !('universeId' in raw) ||
    (raw.universeId !== null && typeof raw.universeId !== 'string')
  )
    throw new Error('Invalid element reference.');
  const reference = parseElementReference({
    entrypoint: raw.entrypoint,
    target: raw.target,
    universeId: raw.universeId
  });
  if (
    !('canonicalPath' in value.record) ||
    value.record.canonicalPath !== reference.target
  )
    throw new Error('Snapshot record does not match its reference.');
  const expected = PathExt.join(
    projectDirectory(reference.entrypoint),
    'chat-attachments',
    await digest(file.content),
    `${reference.target}.json`
  );
  if (attachment.value !== expected)
    throw new Error('Element snapshot content or reference has changed.');
  return value as IElementSnapshot;
}

/** Validate before submission so an old or foreign snapshot cannot silently change context. */
export async function validateElementAttachments(
  contents: Contents.IManager,
  attachments: readonly IAttachment[],
  context: IChatContext | undefined
): Promise<void> {
  for (const attachment of attachments.filter(isElementAttachment)) {
    const snapshot = await readElementAttachment(contents, attachment);
    if (
      !context ||
      snapshot.reference.entrypoint !== context.entrypoint ||
      snapshot.reference.universeId !== context.universeId
    ) {
      throw new Error(
        'This element belongs to another project or universe. Start a matching discussion.'
      );
    }
  }
}
