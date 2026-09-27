import {
  useChatContext,
  type IChatBodyPlaceholderFactory
} from '@jupyter/chat';
import type { Contents } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import React, { useEffect, useState } from 'react';
import { parse } from 'yaml';
import { isRecord } from '../api';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';

interface ISessionPlaceholderProps {
  contents: Contents.IManager;
  trans: TranslationBundle;
}

/**
 * The name the specification of the project owning a chat file declares, or
 * null outside every project. Only `astra.yaml` is read: resolving the whole
 * project for a heading would read its universes and papers too.
 */
async function projectNameOf(
  contents: Contents.IManager,
  chatPath: string
): Promise<string | null> {
  let directory: string;
  try {
    directory = projectDirectory(chatPath);
  } catch {
    return null;
  }
  const root = await findProjectRoot(contents, directory);
  if (!root) {
    return null;
  }
  const spec = await contents.get(root.entrypoint, {
    type: 'file',
    format: 'text',
    content: true
  });
  const document: unknown =
    typeof spec.content === 'string' ? parse(spec.content) : null;
  const name = isRecord(document) ? document.name : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** The body of a session that has no messages yet. */
function SessionPlaceholder(props: ISessionPlaceholderProps): JSX.Element {
  const { contents, trans } = props;
  const { model } = useChatContext();
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    projectNameOf(contents, model.name)
      .then(name => {
        if (!cancelled) {
          setProjectName(name);
        }
      })
      .catch(error => {
        console.warn('Could not name the project of this session.', error);
      });
    return () => {
      cancelled = true;
    };
  }, [contents, model]);
  return (
    <div className="jp-jupyterlab-lightcone-SessionPlaceholder">
      {projectName ? (
        <div className="jp-jupyterlab-lightcone-SessionPlaceholder-project">
          {projectName}
        </div>
      ) : null}
      <div className="jp-jupyterlab-lightcone-SessionPlaceholder-prompt">
        {trans.__('What would you like to explore?')}
      </div>
    </div>
  );
}

/**
 * Jupyter Chat's body placeholder for empty chats: the project's name and an
 * invitation, with no canned suggestions.
 */
export class SessionPlaceholderFactory implements IChatBodyPlaceholderFactory {
  constructor(contents: Contents.IManager, translator?: ITranslator) {
    this._contents = contents;
    this._trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
  }

  create(): JSX.Element {
    return <SessionPlaceholder contents={this._contents} trans={this._trans} />;
  }

  private readonly _contents: Contents.IManager;
  private readonly _trans: TranslationBundle;
}
