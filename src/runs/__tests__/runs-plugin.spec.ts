import type { JupyterFrontEnd } from '@jupyterlab/application';
import { Notification, showErrorMessage } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { runsPlugin, RunsCommandIDs } from '..';
import { getRun, listRuns, startRun } from '../runs-api';
import { FakeEvents, job, refused } from './runs-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../runs-api', () => ({
  ...jest.requireActual('../runs-api'),
  listRuns: jest.fn(),
  startRun: jest.fn(),
  getRun: jest.fn(),
  cancelRun: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';

/** The browser's project. */
class FakeCurrentProject implements ICurrentProject {
  constructor(public project: IProjectRoot | null | undefined) {}
  readonly changed = new Signal<this, void>(this);
}

/** Activate the plugin in a fake shell; the focused widget is `Home`. */
function host(
  options: {
    current?: IProjectRoot | null;
    documentPath?: string;
  } = {}
) {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(analysis('Runs project')),
    'project/data/x.txt': fileModel('x'),
    'elsewhere/notes.txt': fileModel('notes')
  });
  const events = new FakeEvents();
  const disposed = new Signal<object, void>({});
  const home = new Widget();
  home.id = 'home';
  const shell = {
    add: jest.fn(),
    activateById: jest.fn(),
    currentWidget: home as Widget | null,
    disposed
  };
  const commands = new CommandRegistry();
  const app = {
    commands,
    shell,
    serviceManager: {
      contents,
      serverSettings: events.serverSettings,
      events
    }
  } as unknown as JupyterFrontEnd;
  const documents = {
    contextForWidget: (widget: Widget) =>
      widget === home && options.documentPath !== undefined
        ? ({ path: options.documentPath } as DocumentRegistry.Context)
        : undefined
  } as unknown as IDocumentManager;
  const current =
    options.current === undefined
      ? null
      : new FakeCurrentProject(options.current);
  runsPlugin.activate(app, current, documents, null, null);
  /** Run the materialize command with `args`. */
  const materialize = (args: Record<string, unknown>) =>
    commands.execute(RunsCommandIDs.materialize, args as never);
  return {
    commands,
    shell,
    materialize,
    dispose: () => {
      disposed.emit();
      events.dispose();
      contents.dispose();
    }
  };
}

beforeEach(() => {
  jest.mocked(showErrorMessage).mockClear();
  jest.mocked(listRuns).mockReset();
  jest.mocked(listRuns).mockResolvedValue({ runs: [], jobs: [] });
  jest.mocked(startRun).mockReset();
  jest.mocked(getRun).mockReset();
  jest.mocked(getRun).mockImplementation(() => new Promise(() => {}));
});

it('finds the project of the focused document, then the browser’s', async () => {
  jest.mocked(startRun).mockResolvedValue(job());
  let h = host({ documentPath: 'project/data/x.txt', current: null });
  try {
    await h.materialize({});
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: [],
      refresh: false
    });
  } finally {
    h.dispose();
  }
  h = host({ current: { path: 'project', entrypoint: ENTRYPOINT } });
  try {
    await h.materialize({});
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: [],
      refresh: false
    });
  } finally {
    h.dispose();
  }
});

it('says when no project can be found', async () => {
  const h = host({ documentPath: 'elsewhere/notes.txt', current: null });
  try {
    expect(await h.materialize({ cwd: 'elsewhere' })).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not start materialization',
      'No Lightcone project contains elsewhere.'
    );
    expect(await h.materialize({})).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not start materialization',
      'Open a folder inside a Lightcone project first.'
    );
    expect(startRun).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('starts a materialization and follows it in a notification, not a tab', async () => {
  Notification.manager.dismiss();
  const h = host();
  try {
    jest.mocked(startRun).mockResolvedValue(job({ targets: ['a'] }));
    const started = await h.materialize({
      entrypoint: ENTRYPOINT,
      targets: ['a', 3],
      refresh: true
    });
    expect(started).toEqual(job({ targets: ['a'] }));
    expect(startRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['a'],
      refresh: true
    });
    expect(h.shell.add).not.toHaveBeenCalled();
    expect(
      Notification.manager.notifications.map(item => [item.type, item.message])
    ).toEqual([['in-progress', 'Materializing a…']]);

    // A folder inside the project names it.
    await h.materialize({ cwd: 'project/data' });
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: [],
      refresh: false
    });

    jest.mocked(startRun).mockRejectedValue(refused(409));
    expect(await h.materialize({ entrypoint: ENTRYPOINT })).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not start materialization',
      'A materialization is already running for this project. Wait for it to finish or stop it first.'
    );
  } finally {
    h.dispose();
    Notification.manager.dismiss();
  }
});
