import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { addIcon, ellipsesIcon, ReactWidget } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import React from 'react';
import type {
  ComputeBackend,
  IClusterPreset,
  IComputeListing,
  IComputeTarget
} from './compute-api';
import { dotState, startText, targetMeta, targetName } from './compute-labels';
import {
  buildComputeMenu,
  type ComputeMenuItem,
  openBelow
} from './compute-menus';
import type { ComputeModel } from './compute-model';
import { presetCaption, presetMenuLabel } from './compute-presets';
import { askCustomCluster } from './custom-cluster';

const BASE = 'jp-jupyterlab-lightcone-Compute';
const SIDEBAR = 'jp-jupyterlab-lightcone-Sidebar';

/** JupyterLab's command that opens the settings editor. */
export const SETTINGS_EDITOR_COMMAND = 'settingeditor:open';

export interface IComputeSectionProps {
  listing: IComputeListing | null;
  error: string | null;
  pending: boolean;
  trans: TranslationBundle;
  /** Whether "New cluster" has anything to offer. */
  canCreate: boolean;
  /** Whether a cluster can be replaced by one from the same preset. */
  canReplace: (target: IComputeTarget) => boolean;
  onNew: (anchor: HTMLElement) => void;
  onActions: (target: IComputeTarget, anchor: HTMLElement) => void;
  onReplace: (target: IComputeTarget) => void;
}

/** The second line of the active target: its load, its wait, or its problem. */
function Detail({
  target,
  trans,
  pending,
  canReplace,
  onReplace
}: {
  target: IComputeTarget;
  trans: TranslationBundle;
  pending: boolean;
  canReplace: boolean;
  onReplace: () => void;
}): React.ReactElement | null {
  if (target.problem) {
    return (
      <div className={`${BASE}-detail`}>
        <p className={`${BASE}-problem`}>{target.problem.message}</p>
        {target.problem.code === 'version' && canReplace ? (
          <button
            type="button"
            className={`${BASE}-fix jp-Button jp-mod-styled jp-mod-accept`}
            disabled={pending}
            onClick={onReplace}
          >
            {trans.__('Replace')}
          </button>
        ) : null}
      </div>
    );
  }
  if (target.state === 'running' && target.load) {
    const { busy, threads } = target.load;
    return (
      <div className={`${BASE}-detail`}>
        <div
          className={`${BASE}-meter`}
          role="meter"
          aria-label={trans.__('Busy threads')}
          aria-valuemin={0}
          aria-valuemax={threads}
          aria-valuenow={busy}
        >
          <span
            style={{
              width: `${threads ? Math.min(100, (100 * busy) / threads) : 0}%`
            }}
          />
        </div>
        <span className={`${BASE}-caption`}>
          {trans.__('%1 of %2 threads busy', busy, threads)}
        </span>
      </div>
    );
  }
  const waiting =
    target.state === 'queued'
      ? target.startEstimate
        ? startText(target.startEstimate, trans)
        : trans.__('Waiting in the queue')
      : target.state === 'starting'
        ? trans.__('Starting its scheduler and workers…')
        : null;
  return waiting ? (
    <div className={`${BASE}-detail`}>
      <span className={`${BASE}-caption`}>{waiting}</span>
    </div>
  ) : null;
}

/**
 * Where runs can go, one row each: this host, then every cluster. The row
 * `lc materialize` will use carries the active bar and a second line.
 */
export function ComputeSection({
  listing,
  error,
  pending,
  trans,
  canCreate,
  canReplace,
  onNew,
  onActions,
  onReplace
}: IComputeSectionProps): React.ReactElement {
  const hasClusters = !!listing?.targets.some(t => t.kind === 'cluster');
  return (
    <div className={BASE}>
      {error ? (
        <p className={`${SIDEBAR}-message jp-mod-error`} role="alert">
          {error}
        </p>
      ) : null}
      {listing === null && !error ? (
        <p className={`${SIDEBAR}-message`} role="status">
          {trans.__('Looking for compute…')}
        </p>
      ) : null}
      {listing ? (
        <ul
          className={`${BASE}-targets`}
          aria-label={trans.__('Where runs can go')}
        >
          {listing.targets.map(target => {
            const name = targetName(target, trans);
            const dot = dotState(target);
            return (
              <li
                key={target.id}
                className={`${BASE}-target${target.active ? ' jp-mod-active' : ''}${target.other ? ' jp-mod-other' : ''}`}
                aria-current={target.active ? 'true' : undefined}
                title={target.label ?? undefined}
              >
                <div className={`${BASE}-row`}>
                  <span
                    className={`${BASE}-dot`}
                    data-state={dot}
                    aria-hidden="true"
                  >
                    {dot === 'attention' ? '!' : null}
                  </span>
                  <span className={`${BASE}-name`}>{name}</span>
                  <span className={`${BASE}-meta`}>
                    {targetMeta(target, trans)}
                  </span>
                  {target.kind === 'cluster' ? (
                    <button
                      type="button"
                      className={`${BASE}-more`}
                      aria-label={trans.__(
                        'Actions for %1',
                        target.label ?? name
                      )}
                      aria-haspopup="menu"
                      onClick={event => onActions(target, event.currentTarget)}
                    >
                      <ellipsesIcon.react tag="span" elementPosition="center" />
                    </button>
                  ) : null}
                </div>
                {target.active ? (
                  <Detail
                    target={target}
                    trans={trans}
                    pending={pending}
                    canReplace={canReplace(target)}
                    onReplace={() => onReplace(target)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {listing && canCreate ? (
        <button
          type="button"
          className={`${BASE}-new`}
          disabled={pending}
          aria-haspopup="menu"
          onClick={event => onNew(event.currentTarget)}
        >
          <addIcon.react tag="span" elementPosition="center" />
          <span>{trans.__('New cluster')}</span>
        </button>
      ) : null}
      {listing && !listing.attaches && hasClusters ? (
        <p className={`${BASE}-note`}>
          {trans.__(
            'lightcone-cli %1 does not run on clusters yet, so runs stay on this host.',
            listing.lightcone ?? ''
          )}
        </p>
      ) : null}
    </div>
  );
}

export interface IComputeViewOptions {
  model: ComputeModel;
  commands: CommandRegistry;
  translator?: ITranslator | null;
  /** Add a preset to the Compute settings; absent without a settings registry. */
  savePreset?: (preset: IClusterPreset) => Promise<void>;
}

/** The Compute section of the sidebar, with its menus and dialogs. */
export class ComputeView extends ReactWidget {
  constructor(options: IComputeViewOptions) {
    super();
    this.addClass(`${BASE}-host`);
    this._model = options.model;
    this._commands = options.commands;
    this._savePreset = options.savePreset;
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this._model.changed.connect(this.update, this);
  }

  get model(): ComputeModel {
    return this._model;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.changed.disconnect(this.update, this);
    super.dispose();
  }

  protected render(): React.ReactElement {
    const model = this._model;
    return (
      <ComputeSection
        listing={model.listing}
        error={model.error}
        pending={model.pending}
        trans={this._trans}
        canCreate={this._creatable().length > 0 || model.offered.length > 0}
        canReplace={target => this._presetOf(target) !== null}
        onNew={anchor => openBelow(this._newMenu(), anchor)}
        onActions={(target, anchor) =>
          openBelow(this._targetMenu(target), anchor)
        }
        onReplace={target => this._replace(target)}
      />
    );
  }

  /** The presets to start from, then a one-off size and the settings. */
  private _newMenu() {
    const trans = this._trans;
    const model = this._model;
    const items: ComputeMenuItem[] = model.offered.map(preset => ({
      kind: 'action',
      label: presetMenuLabel(preset, trans),
      caption: presetCaption(preset, trans),
      execute: () => this._start(preset)
    }));
    const backends = this._creatable();
    if (items.length && backends.length) {
      items.push({ kind: 'separator' });
    }
    for (const backend of backends) {
      items.push({
        kind: 'action',
        label:
          backends.length > 1
            ? trans.__('Custom %1 cluster…', backendName(backend, trans))
            : trans.__('Custom…'),
        execute: () => this._custom(backend)
      });
    }
    if (this._commands.hasCommand(SETTINGS_EDITOR_COMMAND)) {
      items.push({
        kind: 'action',
        label: trans.__('Edit presets…'),
        execute: () =>
          this._run(trans.__('Could not open the settings'), () =>
            this._commands.execute(SETTINGS_EDITOR_COMMAND, {
              query: 'Lightcone Compute'
            })
          )
      });
    }
    return buildComputeMenu(items, `${BASE}-menu`);
  }

  /** A cluster's facts, its dashboard and Stop. */
  private _targetMenu(target: IComputeTarget) {
    const trans = this._trans;
    const items: ComputeMenuItem[] = [];
    const facts = [target.label, ...(target.details ?? [])].filter(Boolean);
    if (facts.length) {
      items.push({ kind: 'heading', label: facts.join(' · ') });
    }
    const dashboard = target.dashboard;
    if (dashboard) {
      items.push({
        kind: 'action',
        label: trans.__('Open dashboard'),
        execute: () => window.open(dashboard, '_blank', 'noopener')
      });
    }
    if (target.state !== 'stopping') {
      items.push({
        kind: 'action',
        label:
          target.state === 'queued' ? trans.__('Cancel…') : trans.__('Stop…'),
        execute: () => this._stop(target)
      });
    }
    return buildComputeMenu(items, `${BASE}-menu`);
  }

  /**
   * Backends a one-off cluster can be asked of: every one this server can
   * start, except bare local processes where no preset offers them, since on
   * a workstation runs already use every core without a cluster.
   */
  private _creatable(): ComputeBackend[] {
    const offered = this._model.offered;
    return (this._model.listing?.backends ?? []).filter(
      backend =>
        backend !== 'local' ||
        offered.some(preset => preset.backend === 'local')
    );
  }

  private _start(preset: IClusterPreset): void {
    this._run(this._trans.__('Could not start the cluster'), () =>
      this._model.start(preset)
    );
  }

  private _custom(backend: ComputeBackend): void {
    const trans = this._trans;
    this._run(trans.__('Could not start the cluster'), async () => {
      const custom = await askCustomCluster(backend, trans);
      if (!custom) {
        return;
      }
      if (custom.save && this._savePreset) {
        await this._savePreset(custom.preset);
      }
      await this._model.start(custom.preset);
    });
  }

  private _stop(target: IComputeTarget): void {
    const trans = this._trans;
    this._run(trans.__('Could not stop the cluster'), async () => {
      const result = await showDialog({
        title: trans.__(
          'Stop the %1?',
          targetName(target, trans).toLowerCase()
        ),
        body: trans.__(
          'Runs using it, in every project, stop too. Outputs they already made are kept.'
        ),
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({ label: trans.__('Stop cluster') })
        ]
      });
      if (result.button.accept) {
        await this._model.stop(target.id);
      }
    });
  }

  /** Stop a cluster whose workers run another engine, and start its preset again. */
  private _replace(target: IComputeTarget): void {
    const preset = this._presetOf(target);
    if (!preset) {
      return;
    }
    this._run(this._trans.__('Could not replace the cluster'), async () => {
      await this._model.stop(target.id);
      await this._model.start(preset);
    });
  }

  private _presetOf(target: IComputeTarget): IClusterPreset | null {
    return (
      this._model.presets.find(
        preset =>
          preset.label === target.label && preset.backend === target.backend
      ) ?? null
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

  private readonly _model: ComputeModel;
  private readonly _commands: CommandRegistry;
  private readonly _savePreset:
    ((preset: IClusterPreset) => Promise<void>) | undefined;
  private readonly _trans: TranslationBundle;
}

/** A backend as the menus name it. */
export function backendName(
  backend: ComputeBackend,
  trans: TranslationBundle
): string {
  switch (backend) {
    case 'slurm':
      return trans.__('Slurm');
    case 'gateway':
      return trans.__('Dask Gateway');
    default:
      return trans.__('local');
  }
}
