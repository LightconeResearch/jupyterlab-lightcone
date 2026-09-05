import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { requestAPI } from './request';

/**
 * Initialization data for the @lightcone-research/jupyterlab-lightcone extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@lightcone-research/jupyterlab-lightcone:plugin',
  description: 'The open AI workbench for scientific research.',
  autoStart: true,
  optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
    console.log('JupyterLab extension @lightcone-research/jupyterlab-lightcone is activated!');

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log('@lightcone-research/jupyterlab-lightcone settings loaded:', settings.composite);
        })
        .catch(reason => {
          console.error('Failed to load settings for @lightcone-research/jupyterlab-lightcone.', reason);
        });
    }

    requestAPI<any>('hello', app.serviceManager.serverSettings)
      .then(data => {
        console.log(data);
      })
      .catch(reason => {
        console.error(
          `The jupyterlab_lightcone server extension appears to be missing.\n${reason}`
        );
      });
  }
};

export default plugin;
