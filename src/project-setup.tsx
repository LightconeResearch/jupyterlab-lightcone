import React, { useState } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
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
  translator?: ITranslator;
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
    const trans = (this.options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    return <ProjectSetupForm {...this.options} trans={trans} />;
  }
}

/** What the form is doing while it is busy. */
type SetupPhase = 'browsing' | 'checking' | 'setting-up' | 'opening';

/**
 * Why a folder cannot hold a new project: it lies inside `owner`, whose files
 * it would take over (the nearest `astra.yaml` claims a folder).
 */
export function nestedProjectMessage(
  owner: IProjectRoot,
  trans: TranslationBundle
): string {
  const where = owner.path
    ? trans.__('the Lightcone project in %1', owner.path)
    : trans.__('the Lightcone project at the server root');
  return trans.__(
    'This folder is inside %1, and a project cannot be set up inside another one. Choose a folder outside it, or open that project instead.',
    where
  );
}

/**
 * One action: create (or finish) the project in the chosen folder, or open it
 * when the folder already holds one. Asking for a project is the confirmation.
 */
function ProjectSetupForm(
  options: IProjectSetupOptions & { trans: TranslationBundle }
): JSX.Element {
  const [path, setPath] = useState(options.path || '.');
  const [phase, setPhase] = useState<SetupPhase>();
  const [error, setError] = useState('');
  const { mode, trans } = options;
  const busy = phase !== undefined;
  const submitting = busy && phase !== 'browsing';
  const edit = (value: string) => {
    setPath(value);
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
        throw new Error(nestedProjectMessage(owner, trans));
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
  // Announce the same brief progress the button shows visually.
  const status =
    phase === 'browsing'
      ? trans.__('Choosing a folder…')
      : phase === 'checking'
        ? trans.__('Checking the folder…')
        : phase === 'setting-up'
          ? trans.__('Setting up project…')
          : phase === 'opening'
            ? trans.__('Opening the project…')
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
          ? trans.__('Finish project setup')
          : trans.__('Create a Lightcone project')}
      </h1>
      <p>
        {mode === 'finish'
          ? trans.__('Complete or retry setup in the selected folder.')
          : trans.__(
              'Choose a folder for your new project. If it already holds a Lightcone project, that project opens instead.'
            )}{' '}
        {trans.__('The project opens once it is ready.')}
      </p>
      <label htmlFor="lightcone-project-folder">
        {trans.__('Project folder')}
      </label>
      <div className="jp-jupyterlab-lightcone-ProjectSetup-path">
        <input
          id="lightcone-project-folder"
          className="jp-mod-styled"
          value={path}
          onChange={event => edit(event.target.value)}
          disabled={busy}
          placeholder={trans.__('my-project or /absolute/path/to/my-project')}
          autoFocus
        />
        <button
          type="button"
          className="jp-mod-styled"
          disabled={busy}
          onClick={() => void browse()}
        >
          {trans.__('Browse…')}
        </button>
      </div>
      <p className="jp-jupyterlab-lightcone-ProjectSetup-hint">
        {trans.__(
          'Paths are relative to the Jupyter server folder. Absolute paths must be inside it.'
        )}
      </p>
      <p className="jp-jupyterlab-lightcone-ProjectSetup-status" role="status">
        {status}
      </p>
      {error ? <pre role="alert">{error}</pre> : null}
      <button
        type="submit"
        className="jp-mod-styled jp-mod-accept jp-jupyterlab-lightcone-ProjectSetup-submit"
        disabled={busy || !path.trim()}
        aria-busy={submitting}
      >
        {submitting ? (
          <span
            className="jp-jupyterlab-lightcone-ProjectSetup-spinner"
            aria-hidden="true"
          />
        ) : null}
        {phase === 'checking'
          ? trans.__('Checking the folder…')
          : phase === 'setting-up'
            ? trans.__('Setting up project…')
            : phase === 'opening'
              ? trans.__('Opening project…')
              : mode === 'finish'
                ? trans.__('Finish setup')
                : trans.__('Create project')}
      </button>
    </form>
  );
}
