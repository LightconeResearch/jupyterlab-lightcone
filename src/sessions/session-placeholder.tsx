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
import { projectDirectory } from '../project-data';
import { acquireProjectDataService } from '../project-data-service';
import { findProjectRoot } from '../project-root';

interface ISessionPlaceholderProps {
  contents: Contents.IManager;
  trans: TranslationBundle;
}

/** Resolve the name of the project owning a chat file, or null outside every project. */
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
  const lease = acquireProjectDataService(contents, root.entrypoint);
  try {
    const data = await lease.service.get();
    return data.document.analysis.name;
  } finally {
    lease.release();
  }
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
