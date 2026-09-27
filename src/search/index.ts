import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { searchIcon } from '@jupyterlab/ui-components';
import { ICurrentProject } from '../current-project';
import { ISessionService } from '../sessions/session-service';
import { PALETTE_CATEGORY } from '../workbench-ids';
import { SearchController } from './search-controller';

export namespace SearchCommandIDs {
  /** Open the search modal (bound to Accel K in `schema/search.json`). */
  export const search = 'jupyterlab_lightcone:search';
}

/**
 * Ctrl/Cmd+K search over the current project's sessions, ASTRA records,
 * files and Lightcone commands, in a modal palette that opens each hit where
 * it belongs and hands focus back on Escape.
 */
export const searchPlugin: JupyterFrontEndPlugin<void> = {
  // Named after the npm package so that `schema/search.json` (the Accel K
  // shortcut, published as `jupyterlab-lightcone:search`) is loaded: JupyterLab
  // only loads a settings schema whose id names a registered plugin.
  id: 'jupyterlab-lightcone:search',
  description:
    'Search sessions, ASTRA records, project files and Lightcone commands from one modal.',
  autoStart: true,
  requires: [ICurrentProject],
  optional: [ISessionService, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    sessions: ISessionService | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const search = new SearchController({
      app,
      current,
      sessions,
      trans,
      excludedCommands: [SearchCommandIDs.search]
    });

    app.commands.addCommand(SearchCommandIDs.search, {
      label: trans.__('Search Lightcone project'),
      caption: trans.__(
        'Search sessions, results, decisions, inputs, findings, papers, files and commands'
      ),
      icon: searchIcon,
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => search.open()
    });
    palette?.addItem({
      command: SearchCommandIDs.search,
      category: PALETTE_CATEGORY
    });
    app.shell.disposed.connect(() => {
      search.dispose();
    });
  }
};
