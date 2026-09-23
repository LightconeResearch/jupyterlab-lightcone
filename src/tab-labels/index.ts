import {
  ILabShell,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import type { Title, Widget } from '@lumino/widgets';
import { projectDirectory } from '../project-data';
import { findProjectRoot } from '../project-root';
import {
  collidingTabs,
  projectTag,
  shownLabel,
  statedProject,
  TAB_PROJECT_DATASET_KEY,
  type ITabEntry
} from './tab-projects';

export * from './tab-projects';

/** How long a folder's project is trusted before it is looked up again, in ms. */
const LOOKUP_TTL = 60_000;

/**
 * Labels main-area tabs with their project when two projects' tabs would
 * read the same, as two `astra.yaml` inventories or two Homes do. Lab is
 * multi-project, so nothing is closed or swapped; the project's folder name
 * is shown beside the tab's own label. Document tabs keep their label (a
 * document widget renames its file when its label changes): the name goes
 * into the tab's data attribute, which `style/tab-labels.css` shows.
 */
export class TabProjectLabels {
  constructor(
    private readonly _shell: ILabShell,
    private readonly _contents: Contents.IManager,
    private readonly _documents: IDocumentManager | null
  ) {
    _shell.layoutModified.connect(this._schedule, this);
    this._schedule();
  }

  dispose(): void {
    this._shell.layoutModified.disconnect(this._schedule, this);
    for (const title of this._watched) {
      title.changed.disconnect(this._schedule, this);
    }
    this._watched.clear();
    window.clearTimeout(this._timer);
  }

  /** Relabel once the shell settles; many changes arrive together. */
  private _schedule(): void {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => {
      void this._relabel();
    }, 0);
  }

  private async _relabel(): Promise<void> {
    const run = ++this._run;
    const widgets = Array.from(this._shell.widgets('main'));
    for (const widget of widgets) {
      if (!this._watched.has(widget.title)) {
        this._watched.add(widget.title);
        widget.title.changed.connect(this._schedule, this);
        widget.disposed.connect(() => {
          widget.title.changed.disconnect(this._schedule, this);
          this._watched.delete(widget.title);
        });
      }
    }
    const tabs = await Promise.all(
      widgets.map(async widget => ({
        widget,
        label: shownLabel(widget.title),
        project: await this._project(widget)
      }))
    );
    if (run !== this._run) return;
    const labelled = collidingTabs<ITabEntry & { widget: Widget }>(tabs);
    for (const tab of tabs) {
      const title = tab.widget.title;
      const { [TAB_PROJECT_DATASET_KEY]: shown, ...others } = title.dataset;
      const wanted =
        labelled.has(tab) && tab.project !== undefined
          ? projectTag(tab.project)
          : undefined;
      if (wanted === shown) continue;
      title.dataset = wanted
        ? { ...others, [TAB_PROJECT_DATASET_KEY]: wanted }
        : others;
    }
  }

  /** The project folder of a tab: stated by Lightcone views, else found from its file. */
  private async _project(widget: Widget): Promise<string | undefined> {
    const content = widget instanceof MainAreaWidget ? widget.content : widget;
    const stated = statedProject(content);
    if (stated !== undefined) return stated;
    const path = this._documents?.contextForWidget(widget)?.path;
    if (!path) return undefined;
    let directory: string;
    try {
      directory = projectDirectory(path);
    } catch {
      return undefined;
    }
    const cached = this._lookups.get(directory);
    if (cached && Date.now() - cached.at < LOOKUP_TTL) return cached.project;
    const project = findProjectRoot(this._contents, directory).then(
      root => root?.path,
      () => undefined
    );
    this._lookups.set(directory, { at: Date.now(), project });
    return project;
  }

  private _timer = 0;
  private _run = 0;
  private readonly _watched = new Set<Title<Widget>>();
  private readonly _lookups = new Map<
    string,
    { at: number; project: Promise<string | undefined> }
  >();
}

/** Name the project of tabs whose labels would otherwise collide. */
export const tabLabelsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:tab-labels',
  description:
    'Label main-area tabs with their Lightcone project when two projects’ tabs would read the same.',
  autoStart: true,
  optional: [ILabShell, IDocumentManager],
  activate: (
    app: JupyterFrontEnd,
    shell: ILabShell | null,
    documents: IDocumentManager | null
  ) => {
    if (!shell) return;
    const labels = new TabProjectLabels(
      shell,
      app.serviceManager.contents,
      documents
    );
    app.shell.disposed.connect(() => labels.dispose());
  }
};
