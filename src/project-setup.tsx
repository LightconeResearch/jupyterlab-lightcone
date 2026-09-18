import React, { useState } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import {
  inspectProjectFolder,
  initializeProjectFolder,
  type IProjectFolder
} from './api';

interface IProjectSetupOptions {
  path: string;
  mode: 'create' | 'finish';
  settings: ServerConnection.ISettings;
  browse: () => Promise<string | undefined>;
  open: (project: IProjectFolder) => Promise<void>;
}

/** A folder-first entry point; inspection never writes project files. */
export class ProjectSetup extends ReactWidget {
  constructor(private options: IProjectSetupOptions) {
    super();
    this.addClass('jp-jupyterlab-lightcone-ProjectSetup');
  }

  render(): JSX.Element {
    return <ProjectSetupForm {...this.options} />;
  }
}

function ProjectSetupForm(options: IProjectSetupOptions): JSX.Element {
  const [path, setPath] = useState(options.path || '.');
  const [mode, setMode] = useState(options.mode);
  const [project, setProject] = useState<IProjectFolder>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = (value: string) => {
    setPath(value);
    setProject(undefined);
    setError('');
  };
  // An existing project opens directly unless the user asked to finish setup.
  const canOpen = !!project?.hasSpec && mode === 'create';
  const guarded = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (busy || !path.trim()) return;
    setError('');
    return guarded(async () => {
      if (!project) {
        setProject(await inspectProjectFolder(options.settings, path));
      } else if (canOpen) {
        await options.open(project);
      } else {
        await options.open(
          await initializeProjectFolder(options.settings, project.path)
        );
      }
    });
  };
  const browse = () =>
    guarded(async () => {
      const selected = await options.browse();
      if (selected !== undefined) edit(selected || '.');
    });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <h1>
        {mode === 'finish'
          ? 'Finish project setup'
          : 'Create a Lightcone project'}
      </h1>
      <p>
        {mode === 'finish'
          ? 'Complete or retry setup in the selected folder.'
          : 'Choose a folder for your new project, or browse to open an existing one.'}{' '}
        The launcher will open in that folder.
      </p>
      <label htmlFor="lightcone-project-folder">Project folder</label>
      <div className="jp-jupyterlab-lightcone-ProjectSetup-path">
        <input
          id="lightcone-project-folder"
          className="jp-mod-styled"
          value={path}
          onChange={event => edit(event.target.value)}
          disabled={busy}
          placeholder="my-project or /absolute/path/to/my-project"
          autoFocus
        />
        <button
          type="button"
          className="jp-mod-styled"
          disabled={busy}
          onClick={() => void browse()}
        >
          Browse…
        </button>
      </div>
      <p className="jp-jupyterlab-lightcone-ProjectSetup-hint">
        Paths are relative to the Jupyter server folder. Absolute paths must be
        inside it.
      </p>
      {project ? (
        <div className="jp-jupyterlab-lightcone-ProjectSetup-confirm">
          <h2>
            {mode === 'finish'
              ? 'Finish setup in this folder'
              : project.hasSpec
                ? 'ASTRA project found'
                : 'No project in this folder yet'}
          </h2>
          <p>
            <strong>{project.directory}</strong>
          </p>
          <p>
            {canOpen
              ? 'Open the project launcher, or finish setup if a previous attempt was interrupted.'
              : 'Set up the analysis specification, Python environment, Git setup, and report starter. Existing files are preserved.'}
          </p>
        </div>
      ) : null}
      {error ? <pre role="alert">{error}</pre> : null}
      <button
        type="submit"
        className="jp-mod-styled jp-mod-accept"
        disabled={busy || !path.trim()}
      >
        {busy
          ? project
            ? 'Setting up project…'
            : 'Opening…'
          : !project
            ? 'Continue'
            : canOpen
              ? 'Open project'
              : mode === 'finish'
                ? 'Finish setup here'
                : 'Create project here'}
      </button>
      {canOpen ? (
        <button
          type="button"
          className="jp-mod-styled"
          disabled={busy}
          onClick={() => setMode('finish')}
        >
          Finish setup…
        </button>
      ) : null}
    </form>
  );
}
