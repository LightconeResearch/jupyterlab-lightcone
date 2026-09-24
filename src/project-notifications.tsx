import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  Notification,
  ReactWidget,
  showErrorMessage
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { SurfaceKind } from '@astra-spec/ui/model';
import * as React from 'react';
import { AstraKindMark } from './astra-kind';
import { CommandIDs } from './commands';
import { effectiveUniverseId, projectDirectory } from './project-data';
import type { ILoadedProjectData } from './project-data';
import {
  acquireProjectDataService,
  observeProjectDataServices,
  type ProjectDataService
} from './project-data-service';
import {
  diffProjects,
  snapshotProject,
  summarizeChanges,
  type IProjectChange,
  type IProjectSnapshot
} from './project-changes';

/**
 * The kind mark of a change row: a result is an output that was remade, the
 * project and its sub-analyses are analyses, and an insight is a prior one.
 */
export function changeKind(
  kind: IProjectChange['kind']
): SurfaceKind | undefined {
  switch (kind) {
    case 'result':
      return 'output';
    case 'project':
    case 'subanalysis':
      return 'analysis';
    case 'insight':
      return 'prior_insight';
    case 'output':
    case 'decision':
    case 'input':
    case 'finding':
    case 'paper':
      return kind;
    default:
      return undefined;
  }
}

/**
 * A dialog renderer whose body keeps its own controls: the stock renderer
 * stamps every button in the body `jp-mod-styled`, which the review's rows of
 * record links are not. Text bodies render as the stock renderer does.
 */
export class UnstyledBodyRenderer extends Dialog.Renderer {
  createBody(value: Dialog.Body<unknown>): Widget {
    if (typeof value === 'string') {
      return super.createBody(value);
    }
    const body = value instanceof Widget ? value : ReactWidget.create(value);
    // Render the React nodes at once, as the stock renderer does, so the
    // dialog measures a body that is already there.
    MessageLoop.sendMessage(body, Widget.Msg.UpdateRequest);
    body.addClass('jp-Dialog-body');
    return body;
  }
}

/** Artifact hashing shares the browser's connection pool with autosave and kernels. */
const HASH_CONCURRENCY = 4;

const BATCH_INTERVAL = 3000;

interface IWatchedProject {
  services: Set<ProjectDataService>;
  /**
   * Server-side content hash by artifact cache token, which covers mtime and
   * size. A present key with no value means the drive offers no hash.
   */
  hashes: Map<string, string | undefined>;
  baseline?: IProjectSnapshot;
  latest?: {
    snapshot: IProjectSnapshot;
    title: string;
    universeId: string | null;
  };
  pending?: { data: ILoadedProjectData; entrypoint: string };
  /** The snapshot an outstanding notification covers, cleared when the watch ends. */
  reviewing?: IProjectSnapshot;
  draining: boolean;
  timer?: ReturnType<typeof setTimeout>;
  notification?: string;
}

/** One application-owned observer, shared across inventory, cards, and chat views. */
export class ProjectNotifications {
  constructor(
    private readonly contents: Contents.IManager,
    private readonly commands: CommandRegistry,
    translator?: ITranslator
  ) {
    this._trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    this._observer = observeProjectDataServices(contents, service =>
      this._watch(service)
    );
  }

  dispose(): void {
    this._disposed = true;
    this._observer.dispose();
    Signal.disconnectReceiver(this);
    for (const project of this._projects.values()) {
      this._forget(project);
    }
    this._projects.clear();
  }

  private _watch(service: ProjectDataService): void {
    service.projectChanged.connect(this._onProjectChanged, this);
    service.disposed.connect(this._onServiceDisposed, this);
  }

  private _onServiceDisposed(service: ProjectDataService): void {
    for (const [key, project] of this._projects) {
      project.services.delete(service);
      if (!project.services.size) {
        this._forget(project);
        this._projects.delete(key);
      }
    }
  }

  /**
   * Stop batching and release every snapshot. Any notification already shown
   * stays in the centre holding only its rows, which carry no record payload.
   */
  private _forget(project: IWatchedProject): void {
    clearTimeout(project.timer);
    project.timer = undefined;
    project.pending = undefined;
    project.baseline = undefined;
    project.latest = undefined;
    project.reviewing = undefined;
    project.hashes.clear();
  }

  private _onProjectChanged(
    service: ProjectDataService,
    data: ILoadedProjectData
  ): void {
    if (this._disposed) return;
    const key = JSON.stringify([
      service.entrypoint,
      effectiveUniverseId(data.document)
    ]);
    let project = this._projects.get(key);
    if (!project) {
      project = { services: new Set(), hashes: new Map(), draining: false };
      this._projects.set(key, project);
    }
    project.services.add(service);
    // Newest wins: a superseded resolution would only be hashed and discarded.
    project.pending = { data, entrypoint: service.entrypoint };
    void this._drain(key, project);
  }

  private async _drain(key: string, project: IWatchedProject): Promise<void> {
    if (project.draining) return;
    project.draining = true;
    try {
      while (project.pending && !this._disposed) {
        const { data, entrypoint } = project.pending;
        project.pending = undefined;
        try {
          const snapshot = snapshotProject(data);
          await this._fillHashes(project, snapshot, data, entrypoint);
          if (this._disposed || this._projects.get(key) !== project) return;
          this._commit(project, snapshot, data, entrypoint);
        } catch (error) {
          // One bad resolution must not strand the updates queued behind it.
          console.error('Could not compare project updates.', error);
        }
      }
    } finally {
      project.draining = false;
    }
  }

  /**
   * Hash only artifacts whose cache token is new. Contents computes the hash on
   * the server, so no artifact payload is downloaded, but the server still reads
   * each file — hence the concurrency cap.
   */
  private async _fillHashes(
    project: IWatchedProject,
    snapshot: IProjectSnapshot,
    data: ILoadedProjectData,
    entrypoint: string
  ): Promise<void> {
    const root = projectDirectory(entrypoint);
    const queue = [...data.bindings];
    const worker = async (): Promise<void> => {
      for (let binding = queue.pop(); binding; binding = queue.pop()) {
        if (!project.hashes.has(binding.cacheToken)) {
          let hash: string | undefined;
          try {
            const model = await this.contents.get(
              this.contents.resolvePath(root, binding.path),
              { content: false, hash: true }
            );
            if (model.hash && model.hash_algorithm) {
              hash = `${model.hash_algorithm}:${model.hash}`;
            }
          } catch {
            // Hashes are optional on custom drives; never infer a rerun from mtime.
          }
          project.hashes.set(binding.cacheToken, hash);
        }
        snapshot.results.set(
          binding.outputPath,
          project.hashes.get(binding.cacheToken)
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(HASH_CONCURRENCY, queue.length) }, worker)
    );
    // Tokens fold in mtime and size, so stale entries can never be hit again.
    const live = new Set(data.bindings.map(binding => binding.cacheToken));
    for (const token of project.hashes.keys()) {
      if (!live.has(token)) project.hashes.delete(token);
    }
  }

  private _commit(
    project: IWatchedProject,
    snapshot: IProjectSnapshot,
    data: ILoadedProjectData,
    entrypoint: string
  ): void {
    const previous = project.latest;
    const universe = data.document.universe;
    project.latest = {
      snapshot,
      universeId: effectiveUniverseId(data.document),
      title:
        data.document.analysis.name +
        (universe.availableUniverseIds.length > 1
          ? ` · ${universe.universeId}`
          : '')
    };
    if (!previous) {
      project.baseline = snapshot;
      return;
    }
    if (!diffProjects(previous.snapshot, snapshot).length) return;
    // A dismissed notification starts a fresh batch on the next real change.
    if (
      project.notification &&
      !Notification.manager.has(project.notification)
    ) {
      project.notification = undefined;
      project.baseline = previous.snapshot;
    }
    project.timer ??= setTimeout(() => {
      project.timer = undefined;
      this._notify(project, entrypoint);
    }, BATCH_INTERVAL);
  }

  private _notify(project: IWatchedProject, entrypoint: string): void {
    const latest = project.latest;
    if (this._disposed || !project.baseline || !latest) return;
    const reviewed = latest.snapshot;
    const changes = diffProjects(project.baseline, reviewed);
    if (!changes.length) {
      if (project.notification) Notification.dismiss(project.notification);
      project.notification = undefined;
      return;
    }
    const message = `${summarizeChanges(changes)} · ${latest.title}`.slice(
      0,
      140
    );
    // The callback outlives the watch, so it captures rows and scalars only; the
    // snapshot it acknowledges is reachable through the project and released there.
    const { title, universeId } = latest;
    project.reviewing = reviewed;
    const options = {
      autoClose: 5000,
      actions: [
        {
          label: this._trans.__('Review changes'),
          displayType: 'link' as const,
          callback: () => {
            project.baseline = project.reviewing;
            project.notification = undefined;
            void this._review(entrypoint, title, changes, universeId).catch(
              error =>
                showErrorMessage(
                  this._trans.__('Could not review project changes'),
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

  /** The universe the inventory is showing right now, which the user may have changed. */
  private async _inventoryUniverseId(
    entrypoint: string
  ): Promise<string | null> {
    const lease = acquireProjectDataService(this.contents, entrypoint);
    try {
      return effectiveUniverseId((await lease.service.get()).document);
    } finally {
      lease.release();
    }
  }

  private async _review(
    entrypoint: string,
    title: string,
    changes: IProjectChange[],
    universeId: string | null
  ): Promise<void> {
    let selected: IProjectChange | undefined;
    // eslint-disable-next-line jupyter/require-disposable-ownership -- Disposed in the finally block after launch settles.
    const dialog = new Dialog({
      title: this._trans.__('Project updates'),
      renderer: new UnstyledBodyRenderer(),
      body: (
        <div className="jp-jupyterlab-lightcone-ProjectUpdates">
          <p>{title}</p>
          <ul>
            {changes.map(change => {
              const kind = changeKind(change.kind);
              return (
                <li key={change.key}>
                  <span>
                    {kind && <AstraKindMark kind={kind} />} {change.kind}{' '}
                    {change.action}
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
              );
            })}
          </ul>
        </div>
      ),
      buttons: [Dialog.okButton({ label: this._trans.__('Close') })]
    });
    try {
      await dialog.launch();
    } finally {
      dialog.dispose();
    }
    if (!selected || this._disposed) return;
    const reference = selected.reference;
    // The inventory follows its own universe; a pinned record opens its own tab.
    if ((await this._inventoryUniverseId(entrypoint)) !== universeId) {
      await this.commands.execute(CommandIDs.openElement, {
        entrypoint,
        universeId,
        ...(reference?.kind === 'paper'
          ? { target: '', doi: reference.doi }
          : { target: reference?.canonicalPath ?? selected.analysisPath })
      });
      return;
    }
    await this.commands.execute(CommandIDs.openInventory, {
      path: entrypoint,
      analysisPath: selected.analysisPath,
      ...(reference ? { openReference: { ...reference } } : {})
    });
  }

  private _disposed = false;
  private readonly _trans: TranslationBundle;
  private readonly _observer: IDisposable;
  private readonly _projects = new Map<string, IWatchedProject>();
}

/** Watches on its own so a distribution can disable update notices alone. */
export const projectNotificationsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:project-notifications',
  description: 'Group project edits and new results into a JupyterLab notice.',
  autoStart: true,
  optional: [ITranslator],
  activate: (app: JupyterFrontEnd, translator: ITranslator | null) => {
    const notifications = new ProjectNotifications(
      app.serviceManager.contents,
      app.commands,
      translator ?? undefined
    );
    app.shell.disposed.connect(() => notifications.dispose());
  }
};
