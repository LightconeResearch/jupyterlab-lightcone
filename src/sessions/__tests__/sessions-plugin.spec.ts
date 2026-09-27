import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ContentsManager, type Event } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PluginRegistry, Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import { chatPlugin } from '../../chat-plugin';
import { CommandIDs, requireProject } from '../../commands';
import { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import {
  ISessionService,
  SessionManager,
  readNewSessionArgs,
  readOpenSessionArgs,
  sessionsPlugin
} from '..';

jest.mock('@jupyter/chat', () => {
  const { Token } = jest.requireActual('@lumino/coreutils');
  return {
    chatIcon: { bindprops: () => ({}) },
    IChatBodyPlaceholderFactory: new Token('@jupyter/chat:placeholder'),
    IChatCommandRegistry: new Token('@jupyter/chat:commands'),
    IChatTracker: new Token('@jupyter/chat:IChatTracker'),
    useChatContext: jest.fn()
  };
});
jest.mock('../../commands', () => ({
  CommandIDs: {
    discuss: 'jupyterlab_lightcone:discuss',
    newSession: 'jupyterlab_lightcone:new-session',
    openSession: 'jupyterlab_lightcone:open-session'
  },
  requireProject: jest.fn()
}));
jest.mock('../../document-widget', () => ({ InventoryDocument: class {} }));
jest.mock('../../pdf-runtime', () => ({}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));

// The mocked module's token, the one the plugins declare.
const { IChatTracker: CHAT_TRACKER } = jest.requireMock('@jupyter/chat') as {
  IChatTracker: Token<IChatTracker>;
};

const PROJECT: IProjectRoot = { path: 'p', entrypoint: 'p/astra.yaml' };

/** A settable current project. */
class FakeCurrentProject implements ICurrentProject {
  constructor(public project: IProjectRoot | null | undefined) {}
  readonly changed = new Signal<this, void>(this);
}

function fakeApp() {
  const commands = new CommandRegistry();
  const contents = new ContentsManager();
  const shell = {
    currentWidget: null as Widget | null,
    activateById: jest.fn(),
    widgets: () => [].values(),
    disposed: new Signal<object, void>({})
  };
  const app = {
    commands,
    shell,
    // The persona manager is not installed here.
    resolveOptionalService: jest.fn(async () => null),
    serviceManager: {
      contents,
      events: {
        stream: new Signal<Event.IManager, Event.Emission>({} as Event.IManager)
      }
    }
  } as unknown as JupyterFrontEnd;
  return { app, commands, contents, shell };
}

function fakeTracker(): IChatTracker {
  const panels: IChatPanel[] = [];
  return {
    forEach: (fn: (panel: IChatPanel) => void) => panels.forEach(fn),
    find: (fn: (panel: IChatPanel) => boolean) => panels.find(fn),
    widgetAdded: new Signal<object, IChatPanel>({})
  } as unknown as IChatTracker;
}

/** The document manager, which the sessions open chat documents through. */
function fakeDocuments(): IDocumentManager {
  return { openOrReveal: jest.fn() } as unknown as IDocumentManager;
}

/** Register the plugins the way the application does, with fake providers. */
function plugins(options: {
  tracker: boolean;
  project?: IProjectRoot | null;
  /** The file browser's folder, when there is a file browser. */
  browserPath?: string;
}) {
  const host = fakeApp();
  const registry = new PluginRegistry();
  registry.application = host.app;
  registry.registerPlugin({
    id: 'test:current-project',
    provides: ICurrentProject,
    activate: () =>
      new FakeCurrentProject('project' in options ? options.project : PROJECT)
  });
  if (options.browserPath !== undefined) {
    const browser = { model: { path: options.browserPath } };
    registry.registerPlugin({
      id: 'test:file-browser',
      provides: IFileBrowserFactory,
      activate: () => ({ tracker: { currentWidget: browser } })
    });
  }
  registry.registerPlugin({
    id: 'test:documents',
    provides: IDocumentManager,
    activate: () => fakeDocuments()
  });
  if (options.tracker) {
    registry.registerPlugin({
      id: 'test:chat-tracker',
      provides: CHAT_TRACKER,
      activate: () => fakeTracker()
    });
  }
  registry.registerPlugin(sessionsPlugin);
  registry.registerPlugin(chatPlugin);
  return {
    ...host,
    registry,
    /** Dispose the session manager (and its poll) the way the shell does. */
    dispose: () => {
      host.shell.disposed.emit(undefined);
      host.contents.dispose();
    }
  };
}

beforeEach(() => {
  jest.mocked(requireProject).mockReset();
  jest.mocked(showErrorMessage).mockClear();
});

describe('command arguments', () => {
  it('reads strings and ignores values of other types', () => {
    expect(readNewSessionArgs({ cwd: 'p/data', title: 3 })).toEqual({
      entrypoint: undefined,
      cwd: 'p/data',
      title: undefined
    });
    expect(readOpenSessionArgs({ path: 'p/chats/a.chat' })).toEqual({
      path: 'p/chats/a.chat'
    });
    expect(readOpenSessionArgs({ path: '' })).toBeNull();
    expect(readOpenSessionArgs({})).toBeNull();
  });
});

describe('sessionsPlugin', () => {
  it('provides no session service without Jupyter Chat, so surfaces hide sessions', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const host = plugins({ tracker: false });
    try {
      await expect(
        host.registry.resolveOptionalService(ISessionService)
      ).resolves.toBeNull();
      expect(host.commands.hasCommand(CommandIDs.newSession)).toBe(false);
      // The discuss command needs sessions too; its plugin still activates.
      await host.registry.activatePlugin(chatPlugin.id);
      expect(host.commands.hasCommand('jupyterlab_lightcone:discuss')).toBe(
        false
      );
    } finally {
      error.mockRestore();
      host.dispose();
    }
  });

  it('starts sessions in the project the arguments name', async () => {
    const host = plugins({ tracker: true, project: null });
    const service = await host.registry.resolveOptionalService(ISessionService);
    expect(service).toBeInstanceOf(SessionManager);
    const create = jest
      .spyOn(SessionManager.prototype, 'createAndOpen')
      .mockResolvedValue('p/chats/hi.chat');
    try {
      jest.mocked(requireProject).mockResolvedValue(PROJECT);
      await expect(
        host.commands.execute(CommandIDs.newSession, { cwd: 'p/data' })
      ).resolves.toBe('p/chats/hi.chat');
      expect(requireProject).toHaveBeenCalledWith(host.app, {
        directory: 'p/data'
      });
      expect(create).toHaveBeenLastCalledWith('p/astra.yaml', {
        title: undefined
      });

      await host.commands.execute(CommandIDs.newSession, {
        entrypoint: 'p/astra.yaml',
        title: 'Plan'
      });
      expect(requireProject).toHaveBeenLastCalledWith(host.app, {
        entrypoint: 'p/astra.yaml'
      });
      expect(create).toHaveBeenLastCalledWith('p/astra.yaml', {
        title: 'Plan'
      });

      // A project the user declined to set up starts nothing.
      jest.mocked(requireProject).mockResolvedValue(undefined);
      await expect(
        host.commands.execute(CommandIDs.newSession, { cwd: 'x' })
      ).resolves.toBeNull();
      expect(create).toHaveBeenCalledTimes(2);

      // Without arguments or a current project, the user learns why.
      await expect(
        host.commands.execute(CommandIDs.newSession)
      ).resolves.toBeNull();
      expect(showErrorMessage).toHaveBeenCalledWith(
        'No Lightcone project',
        expect.stringContaining('Browse into a Lightcone project')
      );

      jest.mocked(requireProject).mockResolvedValue(PROJECT);
      create.mockRejectedValueOnce(new Error('No chats directory.'));
      await expect(
        host.commands.execute(CommandIDs.newSession, {
          entrypoint: 'p/astra.yaml'
        })
      ).resolves.toBeNull();
      expect(showErrorMessage).toHaveBeenLastCalledWith(
        'Could not start the session',
        new Error('No chats directory.')
      );
    } finally {
      create.mockRestore();
      host.dispose();
    }
  });

  it('locates the project from the file browser while the current one is unknown', async () => {
    const host = plugins({
      tracker: true,
      project: undefined,
      browserPath: 'p/data'
    });
    await host.registry.activatePlugin(sessionsPlugin.id);
    const create = jest
      .spyOn(SessionManager.prototype, 'createAndOpen')
      .mockResolvedValue('p/chats/hi.chat');
    try {
      jest.mocked(requireProject).mockResolvedValue(PROJECT);
      await expect(host.commands.execute(CommandIDs.newSession)).resolves.toBe(
        'p/chats/hi.chat'
      );
      expect(requireProject).toHaveBeenCalledWith(host.app, {
        directory: 'p/data'
      });
      expect(showErrorMessage).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      host.dispose();
    }
  });

  it('starts in the current project and opens sessions by path', async () => {
    const host = plugins({ tracker: true });
    await host.registry.activatePlugin(sessionsPlugin.id);
    const create = jest
      .spyOn(SessionManager.prototype, 'createAndOpen')
      .mockResolvedValue('p/chats/hi.chat');
    const open = jest
      .spyOn(SessionManager.prototype, 'openSession')
      .mockResolvedValue(undefined);
    try {
      await host.commands.execute(CommandIDs.newSession, {});
      expect(requireProject).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith('p/astra.yaml', {
        title: undefined
      });

      await expect(
        host.commands.execute(CommandIDs.openSession, {})
      ).rejects.toThrow('A session path is required.');
      await host.commands.execute(CommandIDs.openSession, {
        path: 'p/chats/hi.chat'
      });
      expect(open).toHaveBeenCalledWith('p/chats/hi.chat');

      open.mockRejectedValueOnce(new Error('gone'));
      await host.commands.execute(CommandIDs.openSession, {
        path: 'p/chats/gone.chat'
      });
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Could not open the session',
        new Error('gone')
      );
      // With sessions available, discuss is offered.
      await host.registry.activatePlugin(chatPlugin.id);
      expect(host.commands.hasCommand('jupyterlab_lightcone:discuss')).toBe(
        true
      );
    } finally {
      create.mockRestore();
      open.mockRestore();
      host.dispose();
    }
  });

  it('starts a discussion in a new session, leaving the draft in its composer', async () => {
    const host = plugins({ tracker: true });
    await host.registry.activatePlugin(chatPlugin.id);
    const create = jest
      .spyOn(SessionManager.prototype, 'createAndOpen')
      .mockResolvedValue('p/chats/discuss-outputs-hubble.chat');
    try {
      jest.mocked(requireProject).mockResolvedValue(PROJECT);
      await expect(
        host.commands.execute('jupyterlab_lightcone:discuss', {
          entrypoint: 'p/astra.yaml',
          target: 'outputs.hubble'
        })
      ).resolves.toEqual({
        entrypoint: 'p/astra.yaml',
        reused: false,
        path: 'p/chats/discuss-outputs-hubble.chat'
      });
      expect(create).toHaveBeenCalledWith('p/astra.yaml', {
        title: 'Discuss outputs.hubble',
        draft: 'Discuss ASTRA element outputs.hubble.'
      });
    } finally {
      create.mockRestore();
      host.dispose();
    }
  });
});
