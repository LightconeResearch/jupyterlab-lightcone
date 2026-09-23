import { PathExt } from '@jupyterlab/coreutils';
import { isRecord } from '../api';

/** The title data key naming a tab's project when labels collide. */
export const TAB_PROJECT_DATASET_KEY = 'lightcone-project';

/** The title data key of a session's shown title (see `session-manager.ts`). */
const SESSION_TITLE_DATASET_KEY = 'lightcone-session-title';

/** A main-area tab as the labeller sees it. */
export interface ITabEntry {
  /** What the tab shows. */
  label: string;
  /** Contents path of the tab's project folder; undefined when unknown. */
  project: string | undefined;
}

/** What a tab shows: a session's title, else its label. */
export function shownLabel(title: {
  label: string;
  dataset: Record<string, string>;
}): string {
  return title.dataset[SESSION_TITLE_DATASET_KEY] ?? title.label;
}

/** A project folder as a tab names it: its last segment, or `/` for the root. */
export function projectTag(project: string): string {
  return PathExt.basename(project) || '/';
}

/**
 * Which tabs to label with their project: those whose shown label another
 * tab of a different project also shows. Tabs of an unknown project are
 * never labelled, and neither are collisions within one project.
 */
export function collidingTabs<T extends ITabEntry>(tabs: readonly T[]): Set<T> {
  const byLabel = new Map<string, T[]>();
  for (const tab of tabs) {
    const group = byLabel.get(tab.label);
    if (group) group.push(tab);
    else byLabel.set(tab.label, [tab]);
  }
  const labelled = new Set<T>();
  for (const group of byLabel.values()) {
    const projects = new Set(
      group.map(tab => tab.project).filter(project => project !== undefined)
    );
    if (projects.size < 2) continue;
    for (const tab of group) {
      if (tab.project !== undefined) labelled.add(tab);
    }
  }
  return labelled;
}

/** The directory holding an `astra.yaml` entrypoint. */
function entrypointFolder(entrypoint: string): string {
  return PathExt.dirname(entrypoint) === '.' ? '' : PathExt.dirname(entrypoint);
}

/**
 * The project entrypoint a Lightcone widget states about itself: a record
 * tab's reference, the Runs or Pipeline view's entrypoint, or Home's project.
 * Undefined for any other widget, whose project is looked up from its file.
 */
export function statedProject(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  const { reference, entrypoint, project } = content;
  if (isRecord(reference) && typeof reference.entrypoint === 'string')
    return entrypointFolder(reference.entrypoint);
  if (typeof entrypoint === 'string' && entrypoint.endsWith('astra.yaml'))
    return entrypointFolder(entrypoint);
  if (isRecord(project) && typeof project.path === 'string')
    return project.path;
  return undefined;
}
