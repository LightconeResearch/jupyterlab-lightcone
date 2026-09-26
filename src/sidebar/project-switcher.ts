import { PathExt } from '@jupyterlab/coreutils';
import type { IStateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import type {
  ReadonlyPartialJSONObject,
  ReadonlyPartialJSONValue
} from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { Menu } from '@lumino/widgets';
import type { ILoadedProjectData } from '../project-data';
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

/** The project's name from its spec, else its folder name. */
export function projectLabel(
  project: IProjectRoot,
  data: ILoadedProjectData | undefined
): string {
  return data?.document.analysis.name.trim() || projectFolderName(project);
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

/** An entry of the switcher that is not a project, such as creating one. */
export interface IProjectSwitcherEntry {
  label: string;
  execute: () => void;
}

/** What the switcher menu lists on one opening. */
export interface IProjectSwitcherContents {
  current: IProjectRoot;
  recent: readonly IProjectRoot[];
  /** Folders beside the current project that hold a project. */
  siblings: readonly string[];
  /** Extra entries after the projects, such as opening or creating one. */
  extras: readonly IProjectSwitcherEntry[];
}

/** The switcher's private command going to a project folder. */
const GO_COMMAND = 'lightcone-switcher:go';
/** The switcher's private command running one of the extra entries. */
const EXTRA_COMMAND = 'lightcone-switcher:extra';

/**
 * The project switcher's menu: recently visited projects, the projects beside
 * this one, then opening or creating one, in groups set apart by separators.
 * Choosing a project moves the file browser there; nothing closes or swaps
 * tabs. One menu lives as long as its owner and is filled again on each
 * opening, since Lumino still reads a menu while its close event runs.
 */
export class ProjectSwitcher implements IDisposable {
  constructor(go: (path: string) => void) {
    const commands = new CommandRegistry();
    const text = (args: ReadonlyPartialJSONObject, key: string): string =>
      typeof args[key] === 'string' ? args[key] : '';
    commands.addCommand(GO_COMMAND, {
      label: args => text(args, 'label'),
      caption: args => text(args, 'caption'),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            label: { type: 'string' },
            caption: { type: 'string' }
          }
        }
      },
      execute: args => go(text(args, 'path'))
    });
    commands.addCommand(EXTRA_COMMAND, {
      label: args => text(args, 'label'),
      describedBy: {
        args: {
          type: 'object',
          properties: { index: { type: 'number' }, label: { type: 'string' } }
        }
      },
      execute: args => {
        const index = typeof args.index === 'number' ? args.index : -1;
        this._extras[index]?.execute();
      }
    });
    this.menu = new Menu({ commands });
    this.menu.addClass('jp-jupyterlab-lightcone-ProjectSwitcher');
  }

  /** The menu; `open` fills it before showing it. */
  readonly menu: Menu;

  get isDisposed(): boolean {
    return this.menu.isDisposed;
  }

  /** Fill the menu with `contents` and open it at a page position. */
  open(contents: IProjectSwitcherContents, x: number, y: number): void {
    this.fill(contents);
    this.menu.open(x, y);
  }

  /** Replace the menu's items; an open menu closes first. */
  fill(contents: IProjectSwitcherContents): void {
    const { menu } = this;
    menu.clearItems();
    this._extras = [...contents.extras];
    const seen = new Set<string>([contents.current.path]);
    const groups: { label: string; caption: string; path: string }[][] = [];
    const recent = contents.recent
      .filter(project => !seen.has(project.path))
      .map(project => {
        seen.add(project.path);
        return {
          label: projectFolderName(project),
          caption: project.path || '/',
          path: project.path
        };
      });
    const siblings = contents.siblings
      .filter(path => !seen.has(path))
      .map(path => ({
        label: projectFolderName({ path }),
        caption: path || '/',
        path
      }));
    for (const group of [recent, siblings]) {
      if (group.length) {
        groups.push(group);
      }
    }
    groups.forEach((group, index) => {
      if (index) {
        menu.addItem({ type: 'separator' });
      }
      for (const args of group) {
        menu.addItem({ command: GO_COMMAND, args });
      }
    });
    if (this._extras.length && groups.length) {
      menu.addItem({ type: 'separator' });
    }
    this._extras.forEach((extra, index) => {
      menu.addItem({
        command: EXTRA_COMMAND,
        args: { index, label: extra.label }
      });
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._extras = [];
    this.menu.dispose();
  }

  private _extras: IProjectSwitcherEntry[] = [];
}
