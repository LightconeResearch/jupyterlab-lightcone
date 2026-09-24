import type { MessagePreambleProps } from '@jupyter/chat';
import React, { useEffect, useMemo, useState } from 'react';
import {
  recordedChatProject,
  type IChatProjectResolver
} from '../chat-links/chat-project';
import type { IComment } from './comments-api';
import type { CommentService } from './comment-service';
import {
  anchorSummary,
  commentIdsFromMetadata,
  commentKind,
  labelGlyph,
  targetName
} from './comment-model';
import { CommentTargetIcon } from './comment-tray';

export interface ICommentCardsDependencies {
  service: CommentService;
  /** Files a chat under its project. */
  projects: IChatProjectResolver;
  /** Open the comment's target. */
  open(comment: IComment): void;
}

/**
 * The preamble component: the comments a message carried, as cards above
 * its body. The IDs ride in the message metadata; the text comes from the
 * project's store, sent comments included.
 */
export function createCommentCards(
  deps: ICommentCardsDependencies
): (props: MessagePreambleProps) => JSX.Element | null {
  return function CommentCards({
    model,
    message
  }: MessagePreambleProps): JSX.Element | null {
    const ids = useMemo(
      () => commentIdsFromMetadata(message.metadata),
      [message.metadata]
    );
    const [comments, setComments] = useState<readonly IComment[]>([]);
    useEffect(() => {
      if (!ids.length) {
        setComments([]);
        return;
      }
      let active = true;
      void deps.projects
        .resolve(model.name, recordedChatProject(model))
        .then(async project => {
          const entrypoint = project?.entrypoint;
          if (!entrypoint) {
            return;
          }
          const all = await deps.service.all(entrypoint);
          if (active) {
            setComments(all.filter(comment => ids.includes(comment.id)));
          }
        })
        .catch(error => {
          console.warn('Could not load the comments of a message.', error);
        });
      return () => {
        active = false;
      };
    }, [ids, model]);
    if (!comments.length) {
      return null;
    }
    return (
      <div
        className="jp-jupyterlab-lightcone-CommentCards"
        role="list"
        aria-label="Comments sent with this message"
      >
        {comments.map(comment => {
          const where = anchorSummary(comment.anchor);
          return (
            <button
              key={comment.id}
              type="button"
              role="listitem"
              className="jp-jupyterlab-lightcone-CommentCard"
              data-kind={commentKind(comment)}
              onClick={() => deps.open(comment)}
            >
              <span className="jp-jupyterlab-lightcone-CommentCard-head">
                <CommentTargetIcon
                  comment={comment}
                  base="jp-jupyterlab-lightcone-CommentCard"
                />
                <span className="jp-jupyterlab-lightcone-CommentCard-label">
                  {labelGlyph(comment.label)}
                </span>
                <span className="jp-jupyterlab-lightcone-CommentCard-target">
                  {targetName(comment.target)}
                </span>
                {comment.target.version.label && (
                  <span className="jp-jupyterlab-lightcone-CommentCard-version">
                    version {comment.target.version.label}
                  </span>
                )}
              </span>
              {where && (
                <span className="jp-jupyterlab-lightcone-CommentCard-where">
                  {where}
                </span>
              )}
              <span className="jp-jupyterlab-lightcone-CommentCard-text">
                {comment.text}
              </span>
            </button>
          );
        })}
      </div>
    );
  };
}
