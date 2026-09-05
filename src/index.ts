import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ASTRA_FILE_TYPE,
  LightconeDocumentWidgetFactory
} from './document-widget';

const PLUGIN_ID = 'jupyterlab_lightcone:plugin';

/** Register the ASTRA file type and its read-only Lightcone document viewer. */
function activate(app: JupyterFrontEnd): void {
  app.docRegistry.addFileType({
    name: ASTRA_FILE_TYPE,
    displayName: 'ASTRA analysis',
    extensions: [],
    pattern: '^astra\\.yaml$',
    mimeTypes: ['text/yaml'],
    contentType: 'file',
    fileFormat: 'text'
  });
  app.docRegistry.addWidgetFactory(
    new LightconeDocumentWidgetFactory(app.serviceManager.contents)
  );
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Open and validate ASTRA projects with Lightcone.',
  autoStart: true,
  activate
};

export default plugin;
