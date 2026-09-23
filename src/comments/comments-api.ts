import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** Whether a comment is still waiting in the composer or already went out. */
export type CommentStatus = 'pending' | 'sent';

/** What a comment is attached to. */
export interface ICommentTarget {
  /** A record of the project, a file, or a chat message. */
  kind: 'record' | 'file' | 'message';
  /** Contents path: the `astra.yaml` for records, the file, or the `.chat`. */
  path: string;
  /** Canonical record path such as `outputs.hubble_diagram`, for records. */
  record: string | null;
  /** Universe the record was resolved in, when relevant. */
  universe: string | null;
  /** Message ID, for comments on a session transcript. */
  message: string | null;
  /** The version the comment was made on. */
  version: {
    commit: string | null;
    key: string | null;
    hash: string | null;
    label: string | null;
  };
}

/** Where inside the target the comment sits. */
export interface ICommentAnchor {
  type: 'point' | 'text' | 'pdf';
  /** Percent across the image, for points. */
  x: number | null;
  /** Percent down the image, for points. */
  y: number | null;
  startLine: number | null;
  startCol: number | null;
  endLine: number | null;
  endCol: number | null;
  /** The selected text, for text and PDF anchors. */
  quote: string | null;
  /** Text just before the selection, to disambiguate the quote. */
  prefix: string | null;
  /** 1-based page number, for PDFs. */
  page: number | null;
}

/** A comment as the server stores it. */
export interface IComment {
  id: string;
  created: string;
  updated: string | null;
  author: string;
  status: CommentStatus;
  sentWith: { chat: string; message: string } | null;
  /** 1-based number among the pending comments of the same target. */
  label: number;
  text: string;
  target: ICommentTarget;
  anchor: ICommentAnchor;
}

/** What the client sends to create a comment. */
export interface ICommentDraft {
  text: string;
  target: ICommentTarget;
  anchor: ICommentAnchor;
}

/** What the client may change on a pending comment. */
export interface ICommentPatch {
  text?: string;
  anchor?: ICommentAnchor;
}

/** Filters for listing comments. */
export interface ICommentQuery {
  status?: CommentStatus | 'all';
  /** Only comments whose `target.path` equals this Contents path. */
  target?: string;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isTarget(value: unknown): value is ICommentTarget {
  return (
    isRecord(value) &&
    (value.kind === 'record' ||
      value.kind === 'file' ||
      value.kind === 'message') &&
    typeof value.path === 'string' &&
    isStringOrNull(value.record) &&
    isStringOrNull(value.universe) &&
    isStringOrNull(value.message) &&
    isRecord(value.version) &&
    isStringOrNull(value.version.commit) &&
    isStringOrNull(value.version.key) &&
    isStringOrNull(value.version.hash) &&
    isStringOrNull(value.version.label)
  );
}

function isAnchor(value: unknown): value is ICommentAnchor {
  return (
    isRecord(value) &&
    (value.type === 'point' || value.type === 'text' || value.type === 'pdf') &&
    isNumberOrNull(value.x) &&
    isNumberOrNull(value.y) &&
    isNumberOrNull(value.startLine) &&
    isNumberOrNull(value.startCol) &&
    isNumberOrNull(value.endLine) &&
    isNumberOrNull(value.endCol) &&
    isStringOrNull(value.quote) &&
    isStringOrNull(value.prefix) &&
    isNumberOrNull(value.page)
  );
}

/** Narrow a server payload to a comment. */
export function isComment(value: unknown): value is IComment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.created === 'string' &&
    isStringOrNull(value.updated) &&
    typeof value.author === 'string' &&
    (value.status === 'pending' || value.status === 'sent') &&
    (value.sentWith === null ||
      (isRecord(value.sentWith) &&
        typeof value.sentWith.chat === 'string' &&
        typeof value.sentWith.message === 'string')) &&
    typeof value.label === 'number' &&
    typeof value.text === 'string' &&
    isTarget(value.target) &&
    isAnchor(value.anchor)
  );
}

function withPath(
  endpoint: string,
  entrypoint: string,
  extra: Record<string, string> = {}
): string {
  return `${endpoint}?${new URLSearchParams({ path: entrypoint, ...extra })}`;
}

/** List the project's comments; pending ones by default. */
export async function listComments(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  query: ICommentQuery = {}
): Promise<IComment[]> {
  try {
    const extra: Record<string, string> = {};
    if (query.status) extra.status = query.status;
    if (query.target) extra.target = query.target;
    const data = await requestAPI(
      withPath('api/comments', entrypoint, extra),
      settings
    );
    if (
      !isRecord(data) ||
      !Array.isArray(data.comments) ||
      !data.comments.every(isComment)
    ) {
      throw new Error('The server returned an invalid comment listing.');
    }
    return data.comments;
  } catch (error) {
    throw new RequestError('Comments', error);
  }
}

/** Save a new pending comment. */
export async function createComment(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  draft: ICommentDraft
): Promise<IComment> {
  try {
    const data = await requestAPI('api/comments', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entrypoint, comment: draft })
    });
    if (!isComment(data)) {
      throw new Error('The server returned an invalid comment.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Comments', error);
  }
}

/** Change the text or anchor of a pending comment. */
export async function updateComment(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  id: string,
  patch: ICommentPatch
): Promise<IComment> {
  try {
    const data = await requestAPI(
      withPath(`api/comments/${encodeURIComponent(id)}`, entrypoint),
      settings,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }
    );
    if (!isComment(data)) {
      throw new Error('The server returned an invalid comment.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Comments', error);
  }
}

/** Delete a pending comment. */
export async function deleteComment(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  id: string
): Promise<void> {
  try {
    await requestAPI(
      withPath(`api/comments/${encodeURIComponent(id)}`, entrypoint),
      settings,
      { method: 'DELETE' }
    );
  } catch (error) {
    throw new RequestError('Comments', error);
  }
}
