import React, { useState } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import {
  inspectProjectFolder,
  initializeProjectFolder,
  type IProjectFolder
} from './api';
import type { IProjectRoot } from './project-root';

interface IProjectSetupOptions {
  path: string;
  mode: 'create' | 'finish';
  settings: ServerConnection.ISettings;
  browse: () => Promise<string | undefined>;
  /** The project at or above a Contents path, as `findProjectRoot` finds it. */
  findProject: (path: string) => Promise<IProjectRoot | undefined>;
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

/** What the form is doing while it is busy. */
type SetupPhase = 'browsing' | 'checking' | 'setting-up' | 'opening';

/**
 * Why a folder cannot hold a new project: it lies inside `owner`, whose files
 * it would take over (the nearest `astra.yaml` claims a folder).
 */
export function nestedProjectMessage(owner: IProjectRoot): string {
  const where = owner.path
    ? `the Lightcone project in ${owner.path}`
    : 'the Lightcone project at the server root';
  return `This folder is inside ${where}, and a project cannot be set up inside another one. Choose a folder outside it, or open that project instead.`;
}

/**
 * One action: create (or finish) the project in the chosen folder, or open it
 * when the folder already holds one. Asking for a project is the confirmation.
 */
function ProjectSetupForm(options: IProjectSetupOptions): JSX.Element {
  const [path, setPath] = useState(options.path || '.');
  const [project, setProject] = useState<IProjectFolder>();
  const [phase, setPhase] = useState<SetupPhase>();
  const [error, setError] = useState('');
  const { mode } = options;
  const busy = phase !== undefined;
  const edit = (value: string) => {
    setPath(value);
    setProject(undefined);
    setError('');
  };
  const run = async (task: () => Promise<void>) => {
    setError('');
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase(undefined);
    }
  };
  const submit = () => {
    if (busy || !path.trim()) return;
    return run(async () => {
      setPhase('checking');
      // Inspection resolves the folder the server will use; it writes nothing.
      const folder = await inspectProjectFolder(options.settings, path);
      setProject(folder);
      if (mode === 'create' && folder.hasSpec) {
        setPhase('opening');
        await options.open(folder);
        return;
      }
      // Setup writes at once, so a folder another project owns is refused
      // before anything is written there.
      const owner = folder.hasSpec
        ? undefined
        : await options.findProject(folder.path);
      if (owner) {
        throw new Error(nestedProjectMessage(owner));
      }
      setPhase('setting-up');
      const ready = await initializeProjectFolder(
        options.settings,
        folder.path
      );
      setPhase('opening');
      await options.open(ready);
    });
  };
  const browse = () => {
    if (busy) return;
    return run(async () => {
      setPhase('browsing');
      const selected = await options.browse();
      if (selected !== undefined) edit(selected || '.');
    });
  };
  // Every busy phase is announced; the visible progress block adds detail.
  const status =
    phase === 'browsing'
      ? 'Choosing a folder…'
      : phase === 'checking'
        ? 'Checking the folder…'
        : phase === 'setting-up'
          ? `Setting up the project in ${project?.directory ?? path}…`
          : phase === 'opening'
            ? 'Opening the project…'
            : '';
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
          : 'Choose a folder for your new project. If it already holds a Lightcone project, that project opens instead.'}{' '}
        The project opens once it is ready.
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
      <p className="jp-jupyterlab-lightcone-ProjectSetup-status" role="status">
        {status}
      </p>
      {phase === 'setting-up' && project ? (
        <div className="jp-jupyterlab-lightcone-ProjectSetup-progress">
          <p>
            <strong>{project.directory}</strong>
          </p>
          <p>
            Setting up the analysis specification, Python environment, Git setup
            and report starter. Existing files are preserved. This can take a
            few minutes.
          </p>
        </div>
      ) : null}
      {error ? <pre role="alert">{error}</pre> : null}
      <button
        type="submit"
        className="jp-mod-styled jp-mod-accept"
        disabled={busy || !path.trim()}
      >
        {phase === 'checking'
          ? 'Checking the folder…'
          : phase === 'setting-up'
            ? 'Setting up project…'
            : phase === 'opening'
              ? 'Opening project…'
              : mode === 'finish'
                ? 'Finish setup'
                : 'Create project'}
      </button>
    </form>
  );
}
