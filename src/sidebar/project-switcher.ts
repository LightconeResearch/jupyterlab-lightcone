import { PathExt } from '@jupyterlab/coreutils';
import type { IStateDB } from '@jupyterlab/statedb';
import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';
import type { Menu } from '@lumino/widgets';
import {
  buildDisposableMenu,
  type DisposableMenuItem
} from '../disposable-menu';
import type { IProjectRoot } from '../project-root';

/** How many recently visited projects the switcher remembers. */
export const RECENT_PROJECT_LIMIT = 8;

/** The state database key of the recently visited projects. */
export const RECENT_PROJECTS_KEY = 'jupyterlab_lightcone:recent-projects';

function isProjectRoot(value: unknown): value is IProjectRoot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    'entrypoint' in value &&
    typeof value.path === 'string' &&
    typeof value.entrypoint === 'string'
  );
}

/** Put a visited project first, once, keeping at most `limit`. */
export function rememberProject(
  recent: readonly IProjectRoot[],
  project: IProjectRoot,
  limit = RECENT_PROJECT_LIMIT
): IProjectRoot[] {
  return [
    project,
    ...recent.filter(item => item.entrypoint !== project.entrypoint)
  ].slice(0, limit);
}

/** A project as the switcher names it: its folder, or `/` at the root. */
export function projectFolderName(project: Pick<IProjectRoot, 'path'>): string {
  return PathExt.basename(project.path) || '/';
}

/**
 * The folder whose other projects the switcher lists: the current project's
 * parent, or the server root for a project at the root.
 */
export function siblingFolder(project: IProjectRoot): string {
  return project.path ? PathExt.dirname(project.path) : '';
}

/**
 * The projects the user visited, most recent first, remembered across
 * reloads in the state database when there is one.
 */
export class RecentProjects {
  constructor(private readonly _state: IStateDB | null) {
    this.ready = this._load();
  }

  /** Settles once the remembered projects are read. */
  readonly ready: Promise<void>;

  get projects(): readonly IProjectRoot[] {
    return this._projects;
  }

  /** Remember a visit; saving failures only cost the memory. */
  async record(project: IProjectRoot): Promise<void> {
    await this.ready;
    this._projects = rememberProject(this._projects, project);
    const saved: ReadonlyPartialJSONValue = this._projects.map(item => ({
      path: item.path,
      entrypoint: item.entrypoint
    }));
    try {
      await this._state?.save(RECENT_PROJECTS_KEY, saved);
    } catch (error) {
      console.warn('Could not remember the recent Lightcone projects.', error);
    }
  }

  private async _load(): Promise<void> {
    try {
      const saved = await this._state?.fetch(RECENT_PROJECTS_KEY);
      if (Array.isArray(saved)) {
        this._projects = saved
          .filter(isProjectRoot)
          .slice(0, RECENT_PROJECT_LIMIT);
      }
    } catch {
      this._projects = [];
    }
  }

  private _projects: IProjectRoot[] = [];
}

/** What the switcher menu lists and does. */
export interface IProjectSwitcherOptions {
  current: IProjectRoot;
  recent: readonly IProjectRoot[];
  /** Folders beside the current project that hold a project. */
  siblings: readonly string[];
  /** Go to a project folder; the current project follows the file browser. */
  go: (path: string) => void;
  /** Extra entries, such as opening or creating a project. */
  extras: { label: string; execute: () => void }[];
}

/**
 * The project switcher's menu: recently visited projects, the projects beside
 * this one, then opening or creating one. Choosing a project moves the file
 * browser there; nothing closes or swaps tabs.
 */
export function buildProjectSwitcher(options: IProjectSwitcherOptions): Menu {
  const items: DisposableMenuItem[] = [];
  const add = (label: string, caption: string, execute: () => void) => {
    items.push({ kind: 'action', label, caption, execute });
  };
  const seen = new Set<string>([options.current.path]);
  const recent = options.recent.filter(item => !seen.has(item.path));
  if (recent.length) {
    items.push({ kind: 'heading', label: 'Recent projects' });
    for (const project of recent) {
      seen.add(project.path);
      add(projectFolderName(project), project.path || '/', () =>
        options.go(project.path)
      );
    }
  }
  const siblings = options.siblings.filter(path => !seen.has(path));
  if (siblings.length) {
    if (recent.length) items.push({ kind: 'separator' });
    items.push({ kind: 'heading', label: 'Projects in this folder' });
    for (const path of siblings) {
      add(PathExt.basename(path) || '/', path || '/', () => options.go(path));
    }
  }
  if (options.extras.length) {
    if (recent.length || siblings.length) items.push({ kind: 'separator' });
    for (const extra of options.extras) {
      add(extra.label, '', extra.execute);
    }
  }
  return buildDisposableMenu(items, 'jp-jupyterlab-lightcone-ProjectSwitcher');
}
