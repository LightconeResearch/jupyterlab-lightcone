import React, { useId } from 'react';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { settingsIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import {
  attentionCount,
  attentionSummary,
  customizeSections,
  themeChoices,
  type ICustomizeSection,
  type IThemeChoices
} from './customize-model';
import { fetchSetup, type ISetupReport } from './setup-api';

/** JupyterLab's own theme switch; the manager is used directly when absent. */
export const CHANGE_THEME_COMMAND = 'apputils:change-theme';

export interface ICustomizeWidgetOptions {
  settings: ServerConnection.ISettings;
  current: ICurrentProject;
  themes: IThemeManager;
  commands: CommandRegistry;
  translator?: ITranslator;
}

interface ICustomizeState {
  /** The last report; kept while refreshing so the page never blanks. */
  report?: ISetupReport;
  /** The project the report describes. */
  project: IProjectRoot | null;
  checked?: Date;
  loading: boolean;
  error?: string;
}

interface ICustomizeViewProps {
  state: ICustomizeState;
  project: IProjectRoot | null;
  theme: string | null;
  themes: IThemeChoices;
  trans: TranslationBundle;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
  onChangeTheme: (name: string) => void;
}

function checkedAt(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function Section({
  section,
  onOpenFile
}: {
  section: ICustomizeSection;
  onOpenFile: (path: string) => void;
}): React.ReactElement {
  const headingId = useId();
  return (
    <section
      className="jp-jupyterlab-lightcone-Customize-section"
      aria-labelledby={headingId}
      data-section={section.id}
    >
      <h2 id={headingId}>{section.title}</h2>
      <p className="jp-jupyterlab-lightcone-Customize-summary">
        {section.summary}
      </p>
      {section.rows.length ? (
        <dl className="jp-jupyterlab-lightcone-Customize-rows">
          {section.rows.map(row => (
            <div
              key={row.id}
              className="jp-jupyterlab-lightcone-Customize-row"
              data-state={row.state}
            >
              <dt>{row.label}</dt>
              <dd>
                <span className="jp-jupyterlab-lightcone-Customize-value">
                  {row.value}
                </span>
                {row.detail ? (
                  <span className="jp-jupyterlab-lightcone-Customize-detail">
                    {row.detail}
                  </span>
                ) : null}
                {row.action ? (
                  <button
                    type="button"
                    className="jp-mod-styled"
                    onClick={() => onOpenFile(row.action!.path)}
                  >
                    {row.action.label}
                  </button>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="jp-jupyterlab-lightcone-Customize-empty">
          {section.empty}
        </p>
      )}
    </section>
  );
}

function Appearance({
  theme,
  themes,
  trans,
  onChangeTheme
}: Pick<
  ICustomizeViewProps,
  'theme' | 'themes' | 'trans' | 'onChangeTheme'
>): React.ReactElement {
  const headingId = useId();
  const selectId = useId();
  const group = (label: string, choices: IThemeChoices['light']) =>
    choices.length ? (
      <optgroup label={label}>
        {choices.map(choice => (
          <option key={choice.name} value={choice.name}>
            {choice.displayName}
          </option>
        ))}
      </optgroup>
    ) : null;
  return (
    <section
      className="jp-jupyterlab-lightcone-Customize-section"
      aria-labelledby={headingId}
      data-section="appearance"
    >
      <h2 id={headingId}>{trans.__('Appearance')}</h2>
      <p className="jp-jupyterlab-lightcone-Customize-summary">
        {trans.__(
          'The JupyterLab theme applies to every surface, including Lightcone’s.'
        )}
      </p>
      <dl className="jp-jupyterlab-lightcone-Customize-rows">
        <div
          className="jp-jupyterlab-lightcone-Customize-row"
          data-state="neutral"
        >
          <dt>
            <label htmlFor={selectId}>{trans.__('Theme')}</label>
          </dt>
          <dd>
            <select
              id={selectId}
              className="jp-mod-styled"
              value={theme ?? ''}
              onChange={event => onChangeTheme(event.target.value)}
            >
              {theme === null ? (
                <option value="">{trans.__('Choose a theme')}</option>
              ) : null}
              {group(trans.__('Light'), themes.light)}
              {group(trans.__('Dark'), themes.dark)}
            </select>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CustomizeView(props: ICustomizeViewProps): React.ReactElement {
  const { state, project, trans } = props;
  const sections = state.report ? customizeSections(state.report) : [];
  const attention = attentionCount(sections);
  return (
    <div className="jp-jupyterlab-lightcone-Customize-page">
      <header className="jp-jupyterlab-lightcone-Customize-header">
        <div>
          <p className="jp-jupyterlab-lightcone-Customize-eyebrow">
            {trans.__('Customize')}
          </p>
          <h1>{trans.__('Lightcone settings')}</h1>
          <p className="jp-jupyterlab-lightcone-Customize-project">
            {project
              ? trans.__('Project %1', project.path || '/')
              : trans.__('No Lightcone project in the current folder')}
          </p>
        </div>
        <div className="jp-jupyterlab-lightcone-Customize-status">
          <span role="status">
            {state.loading
              ? trans.__('Checking…')
              : state.checked
                ? trans.__('Checked at %1', checkedAt(state.checked))
                : ''}
          </span>
          <button
            type="button"
            className="jp-mod-styled"
            onClick={props.onRefresh}
            disabled={state.loading}
          >
            {trans.__('Refresh')}
          </button>
        </div>
      </header>
      {state.error ? (
        <p className="jp-jupyterlab-lightcone-Customize-error" role="alert">
          {trans.__('Could not check the setup: %1', state.error)}
        </p>
      ) : null}
      {state.report ? (
        <>
          <p className="jp-jupyterlab-lightcone-Customize-overview">
            {attentionSummary(attention)}
          </p>
          {sections.map(section => (
            <Section
              key={section.id}
              section={section}
              onOpenFile={props.onOpenFile}
            />
          ))}
        </>
      ) : state.loading ? (
        <p className="jp-jupyterlab-lightcone-Customize-empty" role="status">
          {trans.__('Checking what is installed and configured…')}
        </p>
      ) : null}
      <Appearance
        theme={props.theme}
        themes={props.themes}
        trans={trans}
        onChangeTheme={props.onChangeTheme}
      />
    </div>
  );
}

/**
 * One page of real state: what is installed, discovered and configured for
 * the current project, plus the Lab theme. Follows `ICurrentProject`, so one
 * tab is enough and it never goes stale when the user browses elsewhere.
 */
export class CustomizeWidget extends ReactWidget {
  constructor(options: ICustomizeWidgetOptions) {
    super();
    this._options = options;
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this.addClass('jp-jupyterlab-lightcone-Customize');
    this.title.label = this._trans.__('Lightcone settings');
    this.title.caption = this._trans.__(
      'Agents, skills, project instructions, environment, execution boundary, storage and appearance'
    );
    this.title.icon = settingsIcon;
    this.title.closable = true;
    options.current.changed.connect(this._onProjectChanged, this);
    options.themes.themeChanged.connect(this._onThemeChanged, this);
    void this.refresh();
  }

  /** The report the page shows, once one has loaded. */
  get report(): ISetupReport | undefined {
    return this._state.report;
  }

  /** Fetch the setup report for the current project again. */
  async refresh(): Promise<void> {
    const request = ++this._generation;
    const project = this._options.current.project ?? null;
    this._setState({ ...this._state, loading: true, error: undefined });
    try {
      const report = await fetchSetup(
        this._options.settings,
        project?.entrypoint
      );
      if (this.isDisposed || request !== this._generation) {
        return;
      }
      this._setState({ report, project, checked: new Date(), loading: false });
    } catch (error) {
      if (this.isDisposed || request !== this._generation) {
        return;
      }
      // A report for another project would mislead; keep one for this project.
      const sameProject =
        this._state.project?.entrypoint === project?.entrypoint;
      this._setState({
        ...this._state,
        report: sameProject ? this._state.report : undefined,
        project,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  render(): React.ReactElement {
    const { current, themes } = this._options;
    return (
      <CustomizeView
        state={this._state}
        project={current.project ?? null}
        theme={themes.theme}
        themes={themeChoices(themes)}
        trans={this._trans}
        onRefresh={() => {
          void this.refresh();
        }}
        onOpenFile={path => {
          void this._openFile(path);
        }}
        onChangeTheme={name => {
          void this._changeTheme(name);
        }}
      />
    );
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._options.current.changed.disconnect(this._onProjectChanged, this);
    this._options.themes.themeChanged.disconnect(this._onThemeChanged, this);
    super.dispose();
  }

  private _onProjectChanged(): void {
    void this.refresh();
  }

  private _onThemeChanged(): void {
    this.update();
  }

  /**
   * Open a project file as the tab right after this one: the settings tab
   * stays, and closing the file lands back on it.
   */
  private async _openFile(path: string): Promise<void> {
    const ref = this.parent?.id || this.id;
    try {
      await this._options.commands.execute('docmanager:open', {
        path,
        options: ref ? { mode: 'tab-after', ref } : { mode: 'tab-after' }
      });
    } catch (error) {
      await showErrorMessage(
        this._trans.__('Could not open project instructions'),
        error instanceof Error ? error : String(error)
      );
    }
  }

  private async _changeTheme(name: string): Promise<void> {
    if (!name || name === this._options.themes.theme) {
      return;
    }
    try {
      if (this._options.commands.hasCommand(CHANGE_THEME_COMMAND)) {
        await this._options.commands.execute(CHANGE_THEME_COMMAND, {
          theme: name
        });
      } else {
        await this._options.themes.setTheme(name);
      }
    } catch (error) {
      await showErrorMessage(
        this._trans.__('Could not change the theme'),
        error instanceof Error ? error : String(error)
      );
    }
  }

  private _setState(state: ICustomizeState): void {
    this._state = state;
    this.update();
  }

  private readonly _options: ICustomizeWidgetOptions;
  private readonly _trans: TranslationBundle;
  private _state: ICustomizeState = { project: null, loading: false };
  private _generation = 0;
}
