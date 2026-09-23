import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, showErrorMessage } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
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
import { RunsWidget } from '../runs-widget';
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
  runsPlugin.activate(app, current, documents, null, null, null, null);
  /** Run the open command; the tab and its Runs view, if it opened one. */
  const open = async (
    args: ReadonlyPartialJSONObject
  ): Promise<{ tab: MainAreaWidget; content: RunsWidget } | undefined> => {
    const tab: unknown = await commands.execute(RunsCommandIDs.openRuns, args);
    if (tab === undefined) {
      return undefined;
    }
    if (!(tab instanceof MainAreaWidget)) {
      throw new Error('The Runs command returned something else.');
    }
    const content: unknown = tab.content;
    if (!(content instanceof RunsWidget)) {
      throw new Error('The Runs tab holds something else.');
    }
    return { tab, content };
  };
  return {
    commands,
    shell,
    open,
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

it('opens one Runs tab per project, beside the current tab', async () => {
  const h = host();
  try {
    const opened = await h.open({ cwd: 'project/data' });
    expect(opened?.content.entrypoint).toBe(ENTRYPOINT);
    expect(h.shell.add).toHaveBeenCalledWith(opened?.tab, 'main', {
      mode: 'tab-after',
      ref: 'home',
      activate: true
    });
    const reads = jest.mocked(listRuns).mock.calls.length;
    const again = await h.open({ entrypoint: './project/astra.yaml' });
    expect(again?.tab).toBe(opened?.tab);
    expect(h.shell.add).toHaveBeenCalledTimes(1);
    expect(h.shell.activateById).toHaveBeenCalledWith(opened?.tab.id);
    // Reopening re-reads the runs.
    expect(listRuns).toHaveBeenCalledTimes(reads + 1);
    expect(listRuns).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT);
    await h.open({ entrypoint: ENTRYPOINT, activate: false });
    expect(h.shell.activateById).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('finds the project of the focused document, then the browser’s', async () => {
  let h = host({ documentPath: 'project/data/x.txt', current: null });
  try {
    expect((await h.open({}))?.content.entrypoint).toBe(ENTRYPOINT);
  } finally {
    h.dispose();
  }
  h = host({ current: { path: 'project', entrypoint: ENTRYPOINT } });
  try {
    // The browser's project is read at once, for the Running panel.
    expect(listRuns).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT);
    expect((await h.open({}))?.content.entrypoint).toBe(ENTRYPOINT);
  } finally {
    h.dispose();
  }
});

it('says when no project can be found', async () => {
  const h = host({ documentPath: 'elsewhere/notes.txt', current: null });
  try {
    expect(await h.open({ cwd: 'elsewhere' })).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not open Lightcone runs',
      'No Lightcone project contains elsewhere.'
    );
    expect(await h.open({})).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not open Lightcone runs',
      'Open a folder inside a Lightcone project first.'
    );
    expect(h.shell.add).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('starts a materialization and follows it in the Runs tab', async () => {
  const h = host();
  try {
    jest.mocked(startRun).mockResolvedValue(job({ targets: ['a'] }));
    const started = await h.commands.execute(RunsCommandIDs.materialize, {
      entrypoint: ENTRYPOINT,
      targets: ['a', 3],
      refresh: true
    });
    expect(started).toEqual(job({ targets: ['a'] }));
    expect(startRun).toHaveBeenCalledWith(expect.anything(), ENTRYPOINT, {
      targets: ['a'],
      refresh: true
    });
    expect(h.shell.add).toHaveBeenCalledTimes(1);

    // Like the Runs tab, a folder inside the project names it.
    await h.commands.execute(RunsCommandIDs.materialize, {
      cwd: 'project/data'
    });
    expect(startRun).toHaveBeenLastCalledWith(expect.anything(), ENTRYPOINT, {
      targets: [],
      refresh: false
    });

    jest.mocked(startRun).mockRejectedValue(refused(409));
    expect(
      await h.commands.execute(RunsCommandIDs.materialize, {
        entrypoint: ENTRYPOINT
      })
    ).toBeUndefined();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      'Could not start materialization',
      'A materialization is already running for this project. Wait for it to finish or stop it first.'
    );
  } finally {
    h.dispose();
  }
});
