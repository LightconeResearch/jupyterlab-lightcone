import type { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { ContentsManager } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { collectPaperMetadata } from '../../api';
import type { ICurrentProject } from '../../current-project';
import {
  observeProjectDataServices,
  type ProjectDataService
} from '../../project-data-service';
import type { IProjectRoot } from '../../project-root';
import type { ISessionService } from '../../sessions/session-service';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { SearchController } from '../search-controller';

// Jest does not transform Jupyter Chat's ES modules; only its icon is used.
jest.mock('@jupyter/chat', () => ({ chatIcon: { name: 'chat' } }));
// Open-element's module chain reaches the PDF runtime, whose worker URL uses
// `import.meta`, which Jest's CommonJS build cannot compile.
jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../api', () => ({
  ...jest.requireActual('../../api'),
  collectPaperMetadata: jest.fn(),
  fetchPaper: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn()
}));

const SPEC = `version: '0.0.14'
name: Project
inputs: []
outputs:
  - id: fit
    label: Cosmology fit
    type: metric
    format: json
prior_insights:
  source:
    claim: Earlier result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: paper
        doi: 10.1234/example
`;

const WORK: IProjectRoot = { path: 'work', entrypoint: 'work/astra.yaml' };
const OTHER: IProjectRoot = { path: 'other', entrypoint: 'other/astra.yaml' };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition instead of a fixed delay. */
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for the search modal.');
    }
    await flush();
  }
}

function session(path: string, title: string): ISessionInfo {
  return {
    path,
    title,
    modified: '2026-09-23T10:00:00Z',
    messages: 2,
    lastAgent: 'Codex',
    activity: 'idle'
  };
}

class FakeCurrentProject implements ICurrentProject {
  constructor(public project: IProjectRoot | null | undefined) {}

  get changed(): Signal<this, void> {
    return this._changed;
  }

  /** Settle a lookup, as the file browser's current project does. */
  set(project: IProjectRoot | null | undefined): void {
    this.project = project;
    this._changed.emit();
  }

  private readonly _changed = new Signal<this, void>(this);
}

interface IHarness {
  controller: SearchController;
  current: FakeCurrentProject;
  contents: ContentsManager;
  sessions: jest.Mocked<ISessionService>;
  executed: Array<[string, unknown]>;
  labels: () => string[];
  item: (label: string) => string;
}

const harnesses: IHarness[] = [];

function harness(
  project: IProjectRoot | null | undefined,
  options: { withSessions?: boolean } = {}
): IHarness {
  const { contents } = createContents({
    'work/astra.yaml': fileModel(SPEC),
    'work/notes.md': fileModel('notes'),
    'other/astra.yaml': fileModel(SPEC.replace('Cosmology fit', 'Other fit'))
  });
  const commands = new CommandRegistry();
  const executed: Array<[string, unknown]> = [];
  const record = (id: string) => (args: unknown) => {
    executed.push([id, args]);
  };
  commands.addCommand('jupyterlab_lightcone:open-element', {
    label: 'Open ASTRA element',
    // As registered: its required arguments keep it out of the Commands group.
    describedBy: {
      args: {
        type: 'object',
        required: ['entrypoint', 'target'],
        properties: {}
      }
    },
    execute: record('jupyterlab_lightcone:open-element')
  });
  commands.addCommand('docmanager:open', {
    label: 'Open',
    execute: record('docmanager:open')
  });
  commands.addCommand('jupyterlab_lightcone:create-project', {
    label: 'Create project',
    execute: record('jupyterlab_lightcone:create-project')
  });
  commands.addCommand('jupyterlab_lightcone:search', {
    label: 'Search Lightcone project',
    execute: record('jupyterlab_lightcone:search')
  });
  const sessions: jest.Mocked<ISessionService> = {
    list: jest.fn(async (entrypoint: string) =>
      entrypoint === WORK.entrypoint
        ? [session('work/chats/hubble.chat', 'Hubble session')]
        : [session('other/chats/b.chat', 'Other session')]
    ),
    createAndOpen: jest.fn(),
    openSession: jest.fn().mockResolvedValue(undefined),
    changed: new Signal<ISessionService, string>({} as ISessionService),
    activity: jest.fn().mockReturnValue(undefined)
  };
  const current = new FakeCurrentProject(project);
  const app = {
    commands,
    shell: { currentWidget: null },
    serviceManager: { contents },
    docRegistry: { getFileTypesForPath: () => [] }
  } as unknown as JupyterFrontEnd;
  const controller = new SearchController({
    app,
    current,
    sessions: options.withSessions === false ? null : sessions,
    trans: nullTranslator.load('jupyterlab_lightcone'),
    excludedCommands: ['jupyterlab_lightcone:search']
  });
  const labels = () => controller.palette.items.map(item => item.label).sort();
  const item = (label: string) => {
    const found = controller.palette.items.find(entry => entry.label === label);
    if (!found) {
      throw new Error(`No search item labelled ${label}.`);
    }
    return found.command;
  };
  const created = {
    controller,
    current,
    contents,
    sessions,
    executed,
    labels,
    item
  };
  harnesses.push(created);
  return created;
}

beforeEach(() => {
  jest.mocked(collectPaperMetadata).mockReset().mockResolvedValue({});
  jest.mocked(showErrorMessage).mockReset();
});

afterEach(() => {
  for (const { controller, contents } of harnesses.splice(0)) {
    controller.dispose();
    contents.dispose();
  }
});

describe('SearchController', () => {
  it('loads every group of the project and opens each hit where it belongs', async () => {
    const { controller, sessions, executed, labels, item } = harness(WORK);
    await controller.open();
    expect(controller.modal.isHidden).toBe(false);
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search work: sessions, results, files, commands'
    );
    expect(labels()).toEqual([
      '10.1234/example',
      'Cosmology fit',
      'Create project',
      'Hubble session',
      'astra.yaml',
      'notes.md',
      'source'
    ]);

    const choose = async (label: string) => {
      await controller.palette.commands.execute(item(label));
      await flush();
    };
    await choose('Hubble session');
    expect(sessions.openSession).toHaveBeenCalledWith('work/chats/hubble.chat');
    // Choosing a hit closes the modal.
    expect(controller.modal.isHidden).toBe(true);
    await choose('Cosmology fit');
    await choose('10.1234/example');
    await choose('notes.md');
    await choose('Create project');
    expect(executed).toEqual([
      [
        'jupyterlab_lightcone:open-element',
        { entrypoint: 'work/astra.yaml', target: 'outputs.fit' }
      ],
      [
        'jupyterlab_lightcone:open-element',
        { entrypoint: 'work/astra.yaml', target: '', doi: '10.1234/example' }
      ],
      ['docmanager:open', { path: 'work/notes.md' }],
      ['jupyterlab_lightcone:create-project', {}]
    ]);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('reports a hit that cannot be opened', async () => {
    const { controller } = harness(WORK, { withSessions: false });
    await controller.open();
    expect(controller.palette.items.map(entry => entry.label)).not.toContain(
      'Hubble session'
    );
    controller.palette.setCandidates('sessions', [
      {
        id: 'session:work/chats/hubble.chat',
        kind: 'session',
        category: 'Sessions',
        label: 'Hubble session',
        caption: '',
        rank: 0,
        action: { type: 'session', path: 'work/chats/hubble.chat' }
      }
    ]);
    await controller.palette.commands.execute(
      controller.palette.items.find(entry => entry.label === 'Hubble session')!
        .command
    );
    await until(() => jest.mocked(showErrorMessage).mock.calls.length > 0);
    expect(jest.mocked(showErrorMessage).mock.calls[0][0]).toBe(
      'Could not open Hubble session'
    );
  });

  it("replaces the previous project's groups when the project changes", async () => {
    const { controller, current, labels } = harness(WORK);
    await controller.open();
    expect(labels()).toContain('Cosmology fit');

    // While the modal is open, the new project fills it at once.
    current.set(OTHER);
    await until(() => labels().includes('Other fit'));
    expect(labels()).not.toContain('Cosmology fit');
    expect(labels()).not.toContain('Hubble session');
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search other: sessions, results, files, commands'
    );

    // While it is closed, the next opening starts from the new project.
    controller.modal.hideAndReset();
    current.set(null);
    await controller.open();
    expect(labels()).toEqual(['Create project']);
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search Lightcone commands (no project in this folder)'
    );
  });

  it('drops answers that arrive after a later opening', async () => {
    const { controller, sessions, labels } = harness(WORK);
    const late = new PromiseDelegate<ISessionInfo[]>();
    sessions.list.mockReturnValueOnce(late.promise);
    const first = controller.open();
    sessions.list.mockResolvedValueOnce([
      session('work/chats/new.chat', 'Newest session')
    ]);
    await controller.open();
    late.resolve([session('work/chats/old.chat', 'Stale session')]);
    await first;
    expect(labels()).toContain('Newest session');
    expect(labels()).not.toContain('Stale session');
  });

  it('keeps what it shows while the project lookup is pending or failed', async () => {
    const { controller, current, labels } = harness(undefined);
    await controller.open();
    expect(controller.palette.inputNode.placeholder).toBe('Search');
    expect(labels()).toEqual(['Create project']);

    // The first lookup settles while the modal is open.
    current.set(WORK);
    await until(() => labels().includes('Cosmology fit'));
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search work: sessions, results, files, commands'
    );

    // A failed lookup says nothing about the folder: keep the project's hits.
    controller.modal.hideAndReset();
    current.set(undefined);
    await controller.open();
    expect(controller.palette.inputNode.placeholder).toBe('Search');
    expect(labels()).toContain('Cosmology fit');
    expect(labels()).toContain('Hubble session');

    // A retried lookup that finds the same project names it again.
    current.set(WORK);
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search work: sessions, results, files, commands'
    );
  });

  it('names the missing project once a pending lookup finds none', async () => {
    const { controller, current, labels } = harness(undefined);
    await controller.open();
    expect(controller.palette.inputNode.placeholder).toBe('Search');
    current.set(null);
    expect(controller.palette.inputNode.placeholder).toBe(
      'Search Lightcone commands (no project in this folder)'
    );
    expect(labels()).toEqual(['Create project']);
  });

  it('relabels a paper by its title once the paper cache answers, while open', async () => {
    const papers = new PromiseDelegate<
      Awaited<ReturnType<typeof collectPaperMetadata>>
    >();
    jest.mocked(collectPaperMetadata).mockReturnValueOnce(papers.promise);
    const { controller, contents, labels } = harness(WORK);
    const services: ProjectDataService[] = [];
    const observing = observeProjectDataServices(contents, service => {
      services.push(service);
    });
    try {
      await controller.open();
      expect(labels()).toContain('10.1234/example');
      papers.resolve({ '10.1234/example': { title: 'An example paper' } });
      await until(() => labels().includes('An example paper'));
      expect(labels()).not.toContain('10.1234/example');

      // Closing the modal lets the project data go.
      expect(services.map(service => service.isDisposed)).toEqual([false]);
      controller.modal.hideAndReset();
      expect(services.map(service => service.isDisposed)).toEqual([true]);
    } finally {
      observing.dispose();
    }
  });
});
