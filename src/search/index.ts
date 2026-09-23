import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  ModalCommandPalette,
  showErrorMessage
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { searchIcon } from '@jupyterlab/ui-components';
import { CommandIDs } from '../commands';
import { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import { ISessionService } from '../sessions/session-service';
import type { ISearchCandidate } from './search-candidates';
import {
  SEARCH_CLASS,
  SearchPalette,
  type SearchGroup
} from './search-palette';
import { SearchSources } from './search-sources';

export namespace SearchCommandIDs {
  /** Open the search modal (bound to Accel K in `schema/search.json`). */
  export const search = 'jupyterlab_lightcone:search';
}

const CATEGORY = 'Lightcone Lab';

/**
 * Where a chosen hit opens: sessions in the main area through the session
 * service, records and papers through `open-element` (so they follow the
 * preview and pin rules and split beside a session), files in their default
 * viewer, and commands as themselves.
 */
async function openCandidate(
  app: JupyterFrontEnd,
  sessions: ISessionService | null,
  candidate: ISearchCandidate
): Promise<void> {
  const { action } = candidate;
  switch (action.type) {
    case 'session':
      if (!sessions) {
        throw new Error('Sessions are not available in this JupyterLab.');
      }
      await sessions.openSession(action.path);
      return;
    case 'record':
      await app.commands.execute(CommandIDs.openElement, {
        entrypoint: action.entrypoint,
        target: action.target
      });
      return;
    case 'paper':
      await app.commands.execute(CommandIDs.openElement, {
        entrypoint: action.entrypoint,
        target: '',
        doi: action.doi
      });
      return;
    case 'file':
      await app.commands.execute('docmanager:open', { path: action.path });
      return;
    case 'command':
      await app.commands.execute(action.id);
      return;
  }
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
    const sources = new SearchSources(app, sessions, [SearchCommandIDs.search]);
    const search = new SearchPalette({ placeholder: trans.__('Search') });
    const modal = new ModalCommandPalette({
      commandPalette: search,
      // As the stock palette does: whichever widget is current once the modal
      // closes takes focus, so an opened result keeps it and Escape returns it.
      restore: () => {
        app.shell.currentWidget?.activate();
      }
    });
    modal.addClass(`${SEARCH_CLASS}-Modal`);
    modal.attach();
    search.selected.connect((_sender, candidate) => {
      void openCandidate(app, sessions, candidate).catch(error => {
        void showErrorMessage(
          trans.__('Could not open %1', candidate.label),
          error instanceof Error ? error : String(error)
        );
      });
    });

    let generation = 0;
    let populated: string | null = null;
    const load = async (
      group: SearchGroup,
      opened: number,
      candidates: Promise<ISearchCandidate[]>
    ): Promise<void> => {
      try {
        const loaded = await candidates;
        // A later opening or a closed modal owns the palette now.
        if (opened === generation && !modal.isHidden) {
          search.setCandidates(group, loaded);
        }
      } catch (error) {
        console.warn(`Lightcone search could not list ${group}.`, error);
      }
    };
    const open = (): Promise<void> => {
      const opened = ++generation;
      const project: IProjectRoot | null = current.project ?? null;
      const scope = project?.entrypoint ?? null;
      if (scope !== populated) {
        search.clear();
        populated = scope;
      }
      search.placeholder = project
        ? trans.__(
            'Search %1: sessions, results, files, commands',
            PathExt.basename(project.path) || trans.__('project')
          )
        : trans.__('Search Lightcone commands (no project in this folder)');
      modal.activate();
      const loads = [load('commands', opened, sources.listCommands())];
      if (project) {
        if (sources.hasSessions) {
          loads.push(load('sessions', opened, sources.listSessions(project)));
        }
        loads.push(load('records', opened, sources.listRecords(project)));
        loads.push(load('files', opened, sources.listFiles(project)));
      }
      return Promise.all(loads).then(() => undefined);
    };

    app.commands.addCommand(SearchCommandIDs.search, {
      label: trans.__('Search Lightcone project'),
      caption: trans.__(
        'Search sessions, results, decisions, inputs, findings, papers, files and commands'
      ),
      icon: searchIcon,
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => open()
    });
    palette?.addItem({ command: SearchCommandIDs.search, category: CATEGORY });
    app.shell.disposed.connect(() => {
      modal.dispose();
    });
  }
};
