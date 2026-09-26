import { listOutputs } from '../project-outputs';
import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  InputDialog,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import {
  PanelWithToolbar,
  ReactWidget,
  SidePanel
} from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import React from 'react';
import { CommandIDs } from '../commands';
import { HomeCommandIDs } from '../home/home-commands';
import { lightconeIcon } from '../icons';
import { outputMaterializationStatus } from '../materialization-status';
import {
  SESSION_FILE_EXTENSION,
  sessionStem
} from '../sessions/session-titles';
import type { ISessionInfo } from '../sessions/sessions-api';
import { LightconeThemeBinding } from '../theme-adapter';
import type { IProjectRoot } from '../project-root';
import { analysisRows } from './analysis-rows';
import {
  ProjectSwitcher,
  projectLabel,
  siblingFolder,
  type IProjectSwitcherEntry,
  type RecentProjects
} from './project-switcher';
import { resultsSummaryLabel, summarizeResults } from './results-summary';
import { WorkbenchCommandIDs } from './sidebar-commands';
import type { ISidebarState, SidebarModel } from './sidebar-model';
import {
  AnalysisList,
  ResultsList,
  SessionsList,
  SidebarActions,
  SidebarHeader
} from './sidebar-sections';

/** Sessions shown before the "All N" toggle. */
export const RECENT_SESSIONS = 8;

/** A React view that re-renders on every model change. */
class ModelView extends ReactWidget {
  constructor(
    private readonly _model: SidebarModel,
    private readonly _view: (state: ISidebarState) => React.ReactElement | null
  ) {
    super();
    this._model.changed.connect(this.update, this);
  }

  protected render(): React.ReactElement | null {
    return this._view(this._model.state);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.changed.disconnect(this.update, this);
    super.dispose();
  }
}

/** One accordion section with a count in its title. */
class SidebarSection extends PanelWithToolbar {
  constructor(
    label: string,
    readonly body: ModelView
  ) {
    super();
    this.title.label = label;
    this.addClass('jp-jupyterlab-lightcone-Sidebar-section');
    this._count = new Widget();
    this._count.addClass('jp-jupyterlab-lightcone-Sidebar-count');
    this.toolbar.addItem('count', this._count);
    this.addWidget(body);
  }

  /** The text beside the section title; empty hides it. */
  set count(text: string) {
    if (text !== this._count.node.textContent) {
      this._count.node.textContent = text;
    }
  }

  private readonly _count: Widget;
}

/** Where the project switcher finds projects to offer. */
export interface IProjectSwitcherSource {
  recent: RecentProjects;
  /** Folders inside `folder` that hold a project. */
  siblings: (folder: string) => Promise<string[]>;
}

export interface ILightconeSidebarOptions {
  commands: CommandRegistry;
  model: SidebarModel;
  themes: IThemeManager;
  translator?: ITranslator | null;
  /** Absent: the header offers no project switcher. */
  projects?: IProjectSwitcherSource;
}

/**
 * The Lightcone sidebar: the project, its verbs, sessions, results, analysis
 * and links. Its content follows the current project; it never touches tabs.
 */
export class LightconeSidebar extends SidePanel {
  constructor(options: ILightconeSidebarOptions) {
    super({ translator: options.translator ?? undefined });
    this._commands = options.commands;
    this._model = options.model;
    this._projects = options.projects;
    this._bundle = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    const trans = this._bundle;
    this.id = 'jp-lightcone-sidebar';
    this.title.icon = lightconeIcon;
    this.title.caption = trans.__('Lightcone');
    this.addClass('jp-jupyterlab-lightcone-Sidebar');
    this.node.setAttribute('role', 'region');
    this.node.setAttribute('aria-label', trans.__('Lightcone project'));
    this._theme = new LightconeThemeBinding(options.themes, this.node);
    this._switcher = options.projects
      ? new ProjectSwitcher(path =>
          this._run(trans.__('Could not switch project'), () =>
            this._commands.execute(WorkbenchCommandIDs.goToPath, {
              path: path || '/',
              dontShowBrowser: true
            })
          )
        )
      : null;

    const model = this._model;
    this._headerView = new ModelView(model, state => this._renderHeader(state));
    this._headerView.addClass('jp-jupyterlab-lightcone-Sidebar-headerHost');
    this._actionsView = new ModelView(model, state =>
      this._renderActions(state)
    );
    this._actionsView.addClass('jp-jupyterlab-lightcone-Sidebar-actionsHost');
    this.header.addWidget(this._headerView);
    this.header.addWidget(this._actionsView);

    this._sessionsSection = new SidebarSection(
      trans.__('Sessions'),
      new ModelView(model, state => this._renderSessions(state))
    );
    this._resultsSection = new SidebarSection(
      trans.__('Results'),
      new ModelView(model, state => this._renderResults(state))
    );
    this._analysisSection = new SidebarSection(
      trans.__('Analysis'),
      new ModelView(model, state => this._renderAnalysis(state))
    );

    model.changed.connect(this._onModelChanged, this);
    this._commands.commandChanged.connect(this._onCommandsChanged, this);
    this._commands.keyBindingChanged.connect(this._onCommandsChanged, this);
    this._onModelChanged(model, model.state);
  }

  /** The model this sidebar renders. */
  get model(): SidebarModel {
    return this._model;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.changed.disconnect(this._onModelChanged, this);
    this._commands.commandChanged.disconnect(this._onCommandsChanged, this);
    this._commands.keyBindingChanged.disconnect(this._onCommandsChanged, this);
    this._theme.dispose();
    this._switcher?.dispose();
    for (const section of this._sections) {
      section.dispose();
    }
    super.dispose();
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this._model.visible = this.isVisible;
  }

  protected onBeforeDetach(msg: Message): void {
    this._model.visible = false;
    super.onBeforeDetach(msg);
  }

  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this._model.visible = true;
  }

  protected onBeforeHide(msg: Message): void {
    this._model.visible = false;
    super.onBeforeHide(msg);
  }

  private get _sections(): SidebarSection[] {
    return [this._sessionsSection, this._resultsSection, this._analysisSection];
  }

  private _onModelChanged(_sender: SidebarModel, state: ISidebarState): void {
    const wanted = state.project
      ? this._sections.filter(
          section =>
            section !== this._sessionsSection || !!this._model.sessionService
        )
      : [];
    const present = this.content.widgets;
    const same =
      present.length === wanted.length &&
      wanted.every((section, index) => present[index] === section);
    if (!same) {
      for (const section of this._sections) {
        if (section.parent) {
          section.parent = null;
        }
      }
      for (const section of wanted) {
        this.addWidget(section);
      }
    }
    this._sessionsSection.count = state.sessionsLoaded
      ? `${state.sessions.length}`
      : '';
    if (state.data) {
      const data = state.data;
      const outputs = listOutputs(data);
      this._resultsSection.count = resultsSummaryLabel(
        summarizeResults(outputs, output =>
          outputMaterializationStatus(state.statuses, data, output)
        ),
        this._bundle
      );
    } else {
      this._resultsSection.count = '';
    }
  }

  private _onCommandsChanged(): void {
    this._headerView.update();
    this._actionsView.update();
  }

  /**
   * Offer the recently visited projects and those beside this one. Choosing
   * one moves the file browser there, which the current project follows;
   * no tab is closed or swapped.
   */
  private async _openSwitcher(
    project: IProjectRoot,
    anchor: HTMLElement
  ): Promise<void> {
    const source = this._projects;
    const switcher = this._switcher;
    if (!source || !switcher) {
      return;
    }
    const trans = this._bundle;
    const [siblings] = await Promise.all([
      source.siblings(siblingFolder(project)).catch(error => {
        console.warn('Could not list the projects beside this one.', error);
        return [];
      }),
      source.recent.ready
    ]);
    if (this.isDisposed) {
      return;
    }
    const extras: IProjectSwitcherEntry[] = [];
    for (const [command, label] of [
      [CommandIDs.openExistingProject, trans.__('Open project…')],
      [CommandIDs.createProject, trans.__('New Lightcone project')]
    ] as const) {
      if (this._commands.hasCommand(command)) {
        extras.push({
          label,
          execute: () => this._run(label, () => this._commands.execute(command))
        });
      }
    }
    const rect = anchor.getBoundingClientRect();
    switcher.open(
      { current: project, recent: source.recent.projects, siblings, extras },
      rect.left,
      rect.bottom + 2
    );
  }

  private _run(title: string, action: () => Promise<unknown>): void {
    void action().catch(error => {
      void showErrorMessage(
        title,
        error instanceof Error ? error : String(error)
      );
    });
  }

  private _renderHeader(state: ISidebarState): React.ReactElement {
    const trans = this._bundle;
    const project = state.project;
    return (
      <SidebarHeader
        state={state}
        label={project ? projectLabel(project, state.data) : ''}
        trans={trans}
        onHome={() => {
          if (!project) {
            return;
          }
          // Bring the project's open Home forward when the Home plugin runs;
          // any launcher replacement still answers `launcher:create`.
          this._run(trans.__('Could not open Home'), () =>
            this._commands.hasCommand(HomeCommandIDs.openHome)
              ? this._commands.execute(HomeCommandIDs.openHome, {
                  cwd: project.path
                })
              : this._commands.execute(HomeCommandIDs.create, {
                  cwd: project.path,
                  activate: true
                })
          );
        }}
        onNewProject={
          this._commands.hasCommand(CommandIDs.createProject)
            ? () =>
                this._run(trans.__('Could not create a project'), () =>
                  this._commands.execute(CommandIDs.createProject)
                )
            : undefined
        }
        onSwitch={
          project && this._projects
            ? anchor =>
                this._run(trans.__('Could not list projects'), () =>
                  this._openSwitcher(project, anchor)
                )
            : undefined
        }
      />
    );
  }

  private _renderActions(state: ISidebarState): React.ReactElement | null {
    const trans = this._bundle;
    const project = state.project;
    if (!project) {
      return null;
    }
    const sessions = this._model.sessionService;
    return (
      <SidebarActions
        trans={trans}
        onNewSession={
          sessions
            ? () =>
                this._run(trans.__('Could not start a session'), () =>
                  sessions.createAndOpen(project.entrypoint)
                )
            : undefined
        }
      />
    );
  }

  private _renderSessions(state: ISidebarState): React.ReactElement {
    const trans = this._bundle;
    const sessions = this._model.sessionService;
    return (
      <SessionsList
        state={state}
        activity={session => this._model.activity(session)}
        trans={trans}
        limit={RECENT_SESSIONS}
        expanded={this._allSessions}
        onToggle={() => {
          this._allSessions = !this._allSessions;
          this._sessionsSection.body.update();
        }}
        onOpen={path => {
          if (!sessions) {
            return;
          }
          this._run(trans.__('Could not open the session'), () =>
            sessions.openSession(path)
          );
        }}
        onRename={session =>
          this._run(trans.__('Could not rename the session'), () =>
            this._renameSession(session)
          )
        }
      />
    );
  }

  /**
   * Ask for a new file name and rename the session's chat file. The list
   * refreshes from the rename's file change; an open chat follows the file.
   * The row keeps its title, which the server takes from the first prompt.
   */
  private async _renameSession(session: ISessionInfo): Promise<void> {
    const trans = this._bundle;
    const result = await InputDialog.getText({
      title: trans.__('Rename chat file'),
      label: trans.__('File name'),
      text: sessionStem(session.path),
      suffix: SESSION_FILE_EXTENSION,
      required: true,
      okLabel: trans.__('Rename')
    });
    if (!result.button.accept || result.value === null) {
      return;
    }
    await this._model.renameSession(session.path, result.value);
  }

  private _renderResults(state: ISidebarState): React.ReactElement {
    const trans = this._bundle;
    const data = state.data;
    const entrypoint = state.project?.entrypoint;
    return (
      <ResultsList
        state={state}
        outputs={data ? listOutputs(data) : []}
        statusFor={output =>
          data
            ? outputMaterializationStatus(state.statuses, data, output)
            : undefined
        }
        trans={trans}
        onOpen={(output: ResolvedOutput) => {
          if (!entrypoint) {
            return;
          }
          this._run(trans.__('Could not open the result'), () =>
            this._commands.execute(CommandIDs.openElement, {
              entrypoint,
              target: output.canonicalPath
            })
          );
        }}
        onOpenAll={() => {
          if (!entrypoint) {
            return;
          }
          this._run(trans.__('Could not open the inventory'), () =>
            this._commands.execute(CommandIDs.openInventory, {
              path: entrypoint
            })
          );
        }}
      />
    );
  }

  private _renderAnalysis(state: ISidebarState): React.ReactElement {
    const trans = this._bundle;
    const entrypoint = state.project?.entrypoint;
    return (
      <AnalysisList
        state={state}
        rows={state.data ? analysisRows(state.data) : []}
        trans={trans}
        onOpen={analysisPath => {
          if (!entrypoint) {
            return;
          }
          this._run(trans.__('Could not open the inventory'), () =>
            this._commands.execute(CommandIDs.openInventory, {
              path: entrypoint,
              analysisPath
            })
          );
        }}
      />
    );
  }

  private readonly _commands: CommandRegistry;
  private readonly _model: SidebarModel;
  private readonly _projects: IProjectSwitcherSource | undefined;
  private readonly _switcher: ProjectSwitcher | null;
  private readonly _bundle: TranslationBundle;
  private readonly _theme: LightconeThemeBinding;
  private readonly _headerView: ModelView;
  private readonly _actionsView: ModelView;
  private readonly _sessionsSection: SidebarSection;
  private readonly _resultsSection: SidebarSection;
  private readonly _analysisSection: SidebarSection;
  private _allSessions = false;
}
