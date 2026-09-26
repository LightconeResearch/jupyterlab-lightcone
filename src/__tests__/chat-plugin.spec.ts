import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { ContentsManager } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';
import { chatPlugin } from '../chat-plugin';
import { CommandIDs, requireProject } from '../commands';
import { findProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';

jest.mock('@jupyter/chat', () => {
  const { Token } = jest.requireActual('@lumino/coreutils');
  return {
    IChatTracker: new Token('chat-tracker'),
    chatIcon: { bindprops: () => undefined }
  };
});
jest.mock('../commands', () => ({
  CommandIDs: { discuss: 'lightcone:test-discuss' },
  requireProject: jest.fn()
}));
jest.mock('../project-root', () => ({ findProjectRoot: jest.fn() }));
jest.mock('../document-widget', () => ({ InventoryDocument: class {} }));

const project = { path: 'project', entrypoint: 'project/astra.yaml' };
let contents: ContentsManager;
const widgets: Widget[] = [];

function session(path: string, draft = '', area = 'main'): IChatPanel {
  const panel = Object.assign(new Widget(), {
    area,
    model: {
      name: path,
      ready: Promise.resolve(),
      input: { value: draft, focus: jest.fn(), send: jest.fn() }
    }
  });
  widgets.push(panel);
  return panel as unknown as IChatPanel;
}

async function setup(panels: IChatPanel[], current = panels[0]) {
  const commands = new CommandRegistry();
  const app = {
    commands,
    shell: { currentWidget: current },
    serviceManager: { contents }
  } as unknown as JupyterFrontEnd;
  const tracker = {
    forEach: (callback: (item: IChatPanel) => void) => panels.forEach(callback),
    find: (callback: (item: IChatPanel) => boolean) => panels.find(callback)
  } as unknown as IChatTracker;
  const openSession = jest.fn(async () => undefined);
  const createAndOpen = jest.fn(async () => 'project/chats/new.chat');
  const sessions = { openSession, createAndOpen } as unknown as ISessionService;
  await chatPlugin.activate(app, sessions, tracker, null, null, null);
  return { commands, openSession, createAndOpen };
}

beforeEach(() => {
  contents = new ContentsManager();
  jest.mocked(requireProject).mockResolvedValue(project);
  jest
    .mocked(findProjectRoot)
    .mockImplementation(async (_contents, directory) =>
      directory.startsWith('project/nested')
        ? { path: 'project/nested', entrypoint: 'project/nested/astra.yaml' }
        : project
    );
});

afterEach(() => {
  widgets.splice(0).forEach(widget => widget.dispose());
  contents.dispose();
  jest.clearAllMocks();
});

test('prefers the active project session and appends a draft without sending', async () => {
  const first = session('project/chats/first.chat');
  const active = session('project/chats/current.chat', 'Keep my draft');
  const host = await setup([first, active], active);
  await host.commands.execute(CommandIDs.discuss, {
    entrypoint: project.entrypoint,
    target: 'outputs.plot'
  });
  expect(host.openSession).toHaveBeenCalledWith(active.model.name);
  expect(host.createAndOpen).not.toHaveBeenCalled();
  expect(active.model.input.value).toBe(
    'Keep my draft\n\nDiscuss ASTRA element outputs.plot.'
  );
  expect(active.model.input.send).not.toHaveBeenCalled();
  expect(active.model.input.focus).toHaveBeenCalled();
});

test('does not reuse nested-project or sidebar chats for a new project discussion', async () => {
  const nested = session('project/nested/chats/talk.chat');
  const sidebar = session('project/chat.chat', '', 'sidebar');
  const other = session('elsewhere/chat.chat');
  const host = await setup([nested, sidebar, other], nested);
  await host.commands.execute(CommandIDs.discuss, {
    entrypoint: project.entrypoint,
    target: 'decisions.method'
  });
  expect(host.openSession).not.toHaveBeenCalled();
  expect(host.createAndOpen).toHaveBeenCalledWith(project.entrypoint, {
    title: 'Discuss decisions.method',
    draft: 'Discuss ASTRA element decisions.method.'
  });
});

test('opening the project agent preserves an existing composer draft', async () => {
  const panel = session('project/chats/talk.chat', 'Unsent text');
  const host = await setup([panel]);
  await host.commands.execute(CommandIDs.discuss, {
    entrypoint: project.entrypoint
  });
  expect(panel.model.input.value).toBe('Unsent text');
  expect(panel.model.input.send).not.toHaveBeenCalled();
});
