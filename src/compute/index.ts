import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { type JSONObject, Token } from '@lumino/coreutils';
import { ICurrentProject } from '../current-project';
import type { IClusterPreset, IEndedCluster } from './compute-api';
import { ComputeModel } from './compute-model';
import { parsePresets } from './compute-presets';
import { backendName, ComputeView } from './compute-section';

export * from './compute-api';
export { computeCount } from './compute-labels';
export { ComputeModel } from './compute-model';
export { ComputeSection, ComputeView } from './compute-section';

/** The plugin whose settings hold the cluster presets; settings plugins take the npm package's name. */
export const COMPUTE_PLUGIN_ID = 'jupyterlab-lightcone:compute';

/** The Compute section's model, and a way to make its view. */
export interface ICompute {
  readonly model: ComputeModel;
  /** A new Compute section view; the caller owns and disposes it. */
  createView(): ComputeView;
}

export const ICompute = new Token<ICompute>(
  'jupyterlab_lightcone:ICompute',
  'Where Lightcone runs go: this host or a Dask cluster, and clusters to start and stop.'
);

/**
 * Compute: the Dask clusters `lc materialize` runs on. Clusters belong to
 * the user; the current project only decides which one its runs would use.
 * Presets come from this plugin's settings, which a site ships through
 * JupyterLab's `overrides.json`.
 */
export const computePlugin: JupyterFrontEndPlugin<ICompute> = {
  id: COMPUTE_PLUGIN_ID,
  description:
    'Start, watch and stop the Dask clusters that Lightcone runs execute on.',
  autoStart: true,
  requires: [ICurrentProject],
  optional: [ISettingRegistry, IStateDB, ITranslator],
  provides: ICompute,
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    settings: ISettingRegistry | null,
    state: IStateDB | null,
    translator: ITranslator | null
  ): ICompute => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const model = new ComputeModel({
      serverSettings: app.serviceManager.serverSettings,
      state,
      onEnded: cluster => {
        Notification.info(endedMessage(cluster, trans), { autoClose: false });
      }
    });
    const follow = () => {
      model.project = current.project?.entrypoint ?? null;
    };
    current.changed.connect(follow);
    follow();

    let loaded: ISettingRegistry.ISettings | null = null;
    if (settings) {
      settings
        .load(COMPUTE_PLUGIN_ID)
        .then(plugin => {
          loaded = plugin;
          const apply = () => {
            model.presets = parsePresets(plugin.composite.presets);
          };
          plugin.changed.connect(apply);
          apply();
        })
        .catch(error => {
          console.warn('Could not load the Lightcone Compute presets.', error);
        });
    }
    const savePreset = async (preset: IClusterPreset) => {
      if (!loaded) {
        throw new Error('The Compute settings are not available.');
      }
      const presets = parsePresets(loaded.composite.presets);
      await loaded.set('presets', [...presets, preset].map(presetJSON));
    };
    app.shell.disposed.connect(() => {
      current.changed.disconnect(follow);
      model.dispose();
    });
    return {
      model,
      createView: () =>
        new ComputeView({
          model,
          commands: app.commands,
          translator,
          savePreset: settings ? savePreset : undefined
        })
    };
  }
};

/** "Your Slurm cluster “Regular · 4 nodes · 2 h” reached its time limit." */
export function endedMessage(
  cluster: IEndedCluster,
  trans: TranslationBundle
): string {
  return cluster.label
    ? trans.__(
        'Your %1 cluster “%2” %3.',
        backendName(cluster.backend, trans),
        cluster.label,
        cluster.reason
      )
    : trans.__(
        'Your %1 cluster %2.',
        backendName(cluster.backend, trans),
        cluster.reason
      );
}

/** A preset as settings store it: only the fields it sets. */
function presetJSON(preset: IClusterPreset): JSONObject {
  const json: JSONObject = {};
  for (const [key, value] of Object.entries(preset)) {
    if (typeof value === 'string' || typeof value === 'number') {
      json[key] = value;
    }
  }
  return json;
}
