import type { JupyterFrontEndPlugin } from '@jupyterlab/application';

const PLUGIN_ID = 'jupyterlab_lightcone:plugin';

/** Register the Lightcone extension with JupyterLab. */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'The open AI workbench for scientific research.',
  autoStart: true,
  activate: () => {
    // The foundation registers successfully without startup side effects.
  }
};

export default plugin;
