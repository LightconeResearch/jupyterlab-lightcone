import { Dialog, Notification, showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import * as React from 'react';
import { CommandIDs } from './commands';
import { projectDirectory } from './project-data';
import {
  acquireProjectDataService,
  projectDataUpdated,
  projectDataDisposed,
  type IProjectDataUpdate
} from './project-data-service';
import {
  diffProjects,
  snapshotProject,
  summarizeChanges,
  type IProjectChange,
  type IProjectSnapshot
} from './project-changes';

interface IWatchedProject {
  sources: Set<object>;
  baseline?: IProjectSnapshot;
  current?: IProjectSnapshot;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  notification?: string;
  title: string;
  universeId?: string | null;
}

/** One application-owned observer, shared across inventory, cards, and chat views. */
export class ProjectNotifications {
  constructor(
    private readonly contents: Contents.IManager,
    private readonly commands: CommandRegistry
  ) {
    projectDataUpdated.connect(this._onUpdate, this);
    projectDataDisposed.connect(this._onDisposed, this);
  }

  dispose(): void {
    this._disposed = true;
    projectDataUpdated.disconnect(this._onUpdate, this);
    projectDataDisposed.disconnect(this._onDisposed, this);
    for (const project of this._projects.values()) {
      clearTimeout(project.timer);
    }
    this._projects.clear();
  }

  private _onDisposed(_sender: object, source: object): void {
    for (const [key, project] of this._projects) {
      project.sources.delete(source);
      if (!project.sources.size) {
        clearTimeout(project.timer);
        this._projects.delete(key);
      }
    }
  }

  private _onUpdate(_sender: object, update: IProjectDataUpdate): void {
    if (update.contents !== this.contents || this._disposed) return;
    const key = JSON.stringify([
      update.entrypoint,
      update.data.document.universe.universeId
    ]);
    let project = this._projects.get(key);
    if (!project) {
      project = { sources: new Set(), queue: Promise.resolve(), title: '' };
      this._projects.set(key, project);
    }
    project.sources.add(update.service);
    const watched = project;
    const snapshot = snapshotProject(update.data);
    watched.queue = watched.queue
      .then(async () => {
        if (this._disposed || this._projects.get(key) !== watched) return;
        // Hash only files whose metadata changed. Contents computes the hash on the
        // server: no artifact payloads are downloaded just to show notifications.
        await Promise.all(
          [...snapshot.results].map(async ([path, result]) => {
            const previous = watched.current?.results.get(path);
            if (
              previous?.token === result.token &&
              previous.path === result.path
            ) {
              result.hash = previous.hash;
              return;
            }
            try {
              const model = await this.contents.get(
                this.contents.resolvePath(
                  projectDirectory(update.entrypoint),
                  result.path
                ),
                { content: false, hash: true }
              );
              if (model.hash && model.hash_algorithm)
                result.hash = `${model.hash_algorithm}:${model.hash}`;
            } catch {
              // Hashes are optional on custom drives; never infer a rerun from mtime.
            }
          })
        );
        if (this._disposed || this._projects.get(key) !== watched) return;
        const previous = watched.current;
        watched.current = snapshot;
        const universe = update.data.document.universe;
        watched.universeId =
          universe.source === 'none' ? null : universe.universeId;
        watched.title =
          update.data.document.analysis.name +
          (universe.availableUniverseIds.length > 1
            ? ` · ${universe.universeId}`
            : '');
        if (!previous) {
          watched.baseline = snapshot;
          return;
        }
        if (!diffProjects(previous, snapshot).length) return;
        // A dismissed notification starts a fresh batch on the next real change.
        if (
          watched.notification &&
          !Notification.manager.notifications.some(
            item => item.id === watched.notification
          )
        ) {
          watched.notification = undefined;
          watched.baseline = previous;
        }
        watched.timer ??= setTimeout(() => {
          watched.timer = undefined;
          this._notify(watched, update.entrypoint);
        }, 3000);
      })
      .catch(error =>
        console.error('Could not compare project updates.', error)
      );
  }

  private _notify(project: IWatchedProject, entrypoint: string): void {
    if (this._disposed || !project.baseline || !project.current) return;
    const reviewed = project.current;
    const changes = diffProjects(project.baseline, reviewed);
    if (!changes.length) {
      if (project.notification) Notification.dismiss(project.notification);
      project.notification = undefined;
      return;
    }
    const message = `${summarizeChanges(changes)} · ${project.title}`.slice(
      0,
      140
    );
    const options = {
      autoClose: 5000,
      actions: [
        {
          label: 'Review changes',
          displayType: 'link' as const,
          callback: () => {
            project.baseline = reviewed;
            project.notification = undefined;
            void this._review(
              entrypoint,
              project.title,
              changes,
              project.universeId
            ).catch(error =>
              showErrorMessage(
                'Could not review project changes',
                String(error)
              )
            );
          }
        }
      ]
    };
    if (
      project.notification &&
      Notification.update({ id: project.notification, message, ...options })
    )
      return;
    project.notification = Notification.emit(message, 'default', options);
  }

  private async _review(
    entrypoint: string,
    title: string,
    changes: IProjectChange[],
    universeId: string | null | undefined
  ): Promise<void> {
    let selected: IProjectChange | undefined;
    // eslint-disable-next-line jupyter/require-disposable-ownership -- Disposed in the finally block after launch settles.
    const dialog = new Dialog({
      title: 'Project updates',
      body: (
        <div className="jp-jupyterlab-lightcone-project-updates">
          <p>{title}</p>
          <ul>
            {changes.map(change => (
              <li key={change.key}>
                <span>
                  {change.kind} {change.action}
                </span>
                {change.action === 'removed' ? (
                  <strong>{change.label}</strong>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      selected = change;
                      dialog.resolve();
                    }}
                  >
                    {change.label}
                  </button>
                )}
                {change.detail && <small>{change.detail}</small>}
              </li>
            ))}
          </ul>
        </div>
      ),
      buttons: [Dialog.okButton({ label: 'Close' })]
    });
    try {
      await dialog.launch();
    } finally {
      dialog.dispose();
    }
    if (selected && !this._disposed) {
      const lease = acquireProjectDataService(this.contents, entrypoint);
      let matchesInventory: boolean;
      try {
        const data = await lease.service.get();
        matchesInventory =
          universeId ===
          (data.document.universe.source === 'none'
            ? null
            : data.document.universe.universeId);
      } finally {
        lease.release();
      }
      if (!matchesInventory) {
        const reference = selected.reference;
        await this.commands.execute(CommandIDs.openElement, {
          entrypoint,
          universeId,
          target:
            reference?.kind === 'paper'
              ? ''
              : (reference?.canonicalPath ?? selected.analysisPath),
          ...(reference?.kind === 'paper' ? { doi: reference.doi } : {})
        });
        return;
      }
      await this.commands.execute(CommandIDs.openInventory, {
        path: entrypoint,
        analysisPath: selected.analysisPath,
        ...(selected.reference
          ? { openReference: { ...selected.reference } }
          : {})
      });
    }
  }

  private _disposed = false;
  private readonly _projects = new Map<string, IWatchedProject>();
}
