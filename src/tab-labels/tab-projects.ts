import { MainAreaWidget } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { Widget } from '@lumino/widgets';
import { HomeWidget } from '../home/home-widget';
import { projectDirectory } from '../project-data';
import { isLightconeView } from '../workbench-view';
import { SESSION_TITLE_DATASET_KEY } from '../workbench-ids';

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

/**
 * The project folder a Lightcone widget states about itself: the folder of
 * the entrypoint a workbench view (a record tab, the inventory, the Pipeline
 * view) shows, or the project a Home tab has resolved. The view is the tab
 * itself (the inventory document) or the content of its `MainAreaWidget`.
 * Undefined for any other widget, whose project is looked up from its file.
 */
export function statedProject(widget: Widget): string | undefined {
  const content = widget instanceof MainAreaWidget ? widget.content : widget;
  for (const candidate of [widget, content]) {
    if (isLightconeView(candidate)) {
      return projectDirectory(candidate.entrypoint);
    }
  }
  return content instanceof HomeWidget
    ? (content.project?.path ?? undefined)
    : undefined;
}
