import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { createFileContext } from '@jupyterlab/docregistry/lib/testutils';
import type { Contents } from '@jupyterlab/services';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { InventoryDocument } from '../../document-widget';
import {
  observeProjectDataServices,
  type ProjectDataService
} from '../../project-data-service';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  CoalescingRunner,
  SidebarModel,
  type ISidebarState
} from '../sidebar-model';
import {
  FakeChatPanel,
  FakeCurrentProject,
  FakeSessionService,
  PROJECT_SPEC,
  flush,
  session,
  until
} from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
const request = jest.mocked(requestAPI);

function statuses(outputs: Record<string, string>) {
  return {
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, state]) => [
        key,
        { state, detail: '' }
      ])
    )
  };
}

class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

/** Make the browser tab hidden or visible, as Lumino's polls see it. */
function setDocumentHidden(hidden: boolean | undefined): void {
  if (hidden === undefined) {
    Reflect.deleteProperty(document, 'visibilityState');
  } else {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible')
    });
  }
  document.dispatchEvent(new Event('visibilitychange'));
}

function host(
  options: {
    sessions?: boolean;
    entries?: Record<string, Contents.IModel>;
  } = {}
) {
  const { contents, get } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC),
    'project/myst.yml': fileModel('project: {}'),
    'other/astra.yaml': fileModel(
      'version: "0.0.14"\nname: Other\ninputs: []\noutputs: []\n'
    ),
    ...options.entries
  });
  request.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return statuses({
        'default/hubble_diagram': 'current',
        'default/cosmology_fit': 'behind'
      });
    }
    return { papers: {} };
  });
  const current = new FakeCurrentProject({
    path: 'project',
    entrypoint: 'project/astra.yaml'
  });
  const sessions = options.sessions === false ? null : new FakeSessionService();
  sessions?.listings.set('project/astra.yaml', [
    session(),
    session({
      path: 'project/chats/contours.chat',
      title: 'Contour styling',
      activity: 'working'
    })
  ]);
  const shell = {
    currentWidget: null as Widget | null,
    currentChanged: new Signal<object, unknown>({})
  };
  const model = new SidebarModel({
    contents,
    shell,
    current,
    sessions
  });
  const states: ISidebarState[] = [];
  model.changed.connect((_sender, state) => states.push(state));
  return {
    contents,
    get,
    current,
    sessions,
    shell,
    model,
    states,
    dispose: () => {
      model.dispose();
      contents.dispose();
    }
  };
}

beforeEach(() => {
  request.mockReset();
});

describe('SidebarModel', () => {
  it('gathers project data, statuses, sessions', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(
        () =>
          !!h.model.state.data &&
          !!h.model.state.statuses &&
          h.model.state.sessionsLoaded
      );
      const state = h.model.state;
      expect(state.project?.entrypoint).toBe('project/astra.yaml');
      expect(state.data?.document.analysis.name).toBe('Sidebar project');
      expect(state.statuses?.['default/cosmology_fit'].state).toBe('behind');
      expect(state.sessions.map(item => item.title)).toEqual([
        'Hubble diagram with error bars',
        'Contour styling'
      ]);
      expect(state.error).toBeUndefined();
      expect(state.statusError).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it('prefers the live activity of an open chat', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(() => h.model.state.sessionsLoaded);
      const [first, second] = h.model.state.sessions;
      expect(h.model.activity(first)).toBe('idle');
      expect(h.model.activity(second)).toBe('working');
      h.sessions!.live.set(first.path, 'attention');
      expect(h.model.activity(first)).toBe('attention');
    } finally {
      h.dispose();
    }
  });

  it('does not poll while hidden and refreshes once shown', async () => {
    const h = host();
    try {
      await flush();
      await flush();
      expect(h.sessions!.list).not.toHaveBeenCalled();
      expect(
        request.mock.calls.filter(([endpoint]) =>
          endpoint.startsWith('api/materialization')
        )
      ).toHaveLength(0);
      h.model.visible = true;
      await until(() => h.model.state.sessionsLoaded);
      expect(h.sessions!.list).toHaveBeenCalledWith('project/astra.yaml');
    } finally {
      h.dispose();
    }
  });

  it('holds no project data lease and reads nothing while hidden', async () => {
    const h = host();
    const services: ProjectDataService[] = [];
    const observer = observeProjectDataServices(h.contents, service =>
      services.push(service)
    );
    try {
      await flush();
      await flush();
      expect(services).toHaveLength(0);
      expect(h.get).not.toHaveBeenCalled();
      h.model.visible = true;
      await until(() => !!h.model.state.data);
      expect(services).toHaveLength(1);
      h.model.visible = false;
      expect(services[0].isDisposed).toBe(true);
      // What the sidebar showed stays, and shows at once when it comes back.
      expect(h.model.state.data?.document.analysis.name).toBe(
        'Sidebar project'
      );
      h.model.visible = true;
      expect(services).toHaveLength(2);
      expect(h.model.state.data?.document.analysis.name).toBe(
        'Sidebar project'
      );
      await until(() => services[1].state.data !== undefined);
      expect(h.model.state.data).toBe(services[1].state.data);
    } finally {
      observer.dispose();
      h.dispose();
    }
  });

  it('stops polling while the browser tab is hidden', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const h = host();
    try {
      h.model.visible = true;
      await jest.advanceTimersByTimeAsync(1000);
      expect(h.model.state.sessionsLoaded).toBe(true);
      const shown = h.sessions!.list.mock.calls.length;
      await jest.advanceTimersByTimeAsync(31000);
      expect(h.sessions!.list.mock.calls.length).toBeGreaterThan(shown);
      setDocumentHidden(true);
      // Lumino lets a poll run one more tick after the tab is hidden.
      await jest.advanceTimersByTimeAsync(31000);
      const sessions = h.sessions!.list.mock.calls.length;
      const statuses = request.mock.calls.length;
      await jest.advanceTimersByTimeAsync(120000);
      expect(h.sessions!.list.mock.calls.length).toBe(sessions);
      expect(request.mock.calls.length).toBe(statuses);
      setDocumentHidden(false);
      await jest.advanceTimersByTimeAsync(31000);
      expect(h.sessions!.list.mock.calls.length).toBeGreaterThan(sessions);
    } finally {
      setDocumentHidden(undefined);
      h.dispose();
      jest.useRealTimers();
    }
  });

  it('clears everything when the project changes and ignores stale answers', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(() => h.model.state.sessionsLoaded && !!h.model.state.data);
      let release: (value: never[]) => void = () => undefined;
      h.sessions!.list.mockImplementationOnce(
        () => new Promise(resolve => (release = resolve))
      );
      h.sessions!.changed.emit('project/astra.yaml');
      await flush();
      h.current.set({ path: 'other', entrypoint: 'other/astra.yaml' });
      await flush();
      expect(h.model.state.sessions).toEqual([]);
      expect(h.model.state.data).toBeUndefined();
      // The slow listing for the previous project arrives too late to count.
      release([]);
      await until(() => h.model.state.sessionsLoaded);
      expect(h.model.state.sessions).toEqual([]);
      await until(() => h.model.state.data?.document.analysis.name === 'Other');
      h.current.set(null);
      await flush();
      expect(h.model.state.project).toBeNull();
      expect(h.model.state.data).toBeUndefined();
      expect(h.model.state.sessionsLoaded).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('lists the new project at once when it changes during a listing', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(() => h.model.state.sessionsLoaded);
      h.sessions!.listings.set('other/astra.yaml', [
        session({ path: 'other/chats/other.chat', title: 'Other session' })
      ]);
      let release: (value: never[]) => void = () => undefined;
      h.sessions!.list.mockImplementationOnce(
        () => new Promise(resolve => (release = resolve))
      );
      const calls = h.sessions!.list.mock.calls.length;
      h.sessions!.changed.emit('project/astra.yaml');
      await until(() => h.sessions!.list.mock.calls.length > calls);
      // The project changes while its listing is still in flight.
      h.current.set({ path: 'other', entrypoint: 'other/astra.yaml' });
      await flush();
      release([]);
      await until(() =>
        h.model.state.sessions.some(item => item.title === 'Other session')
      );
      expect(h.sessions!.list).toHaveBeenLastCalledWith('other/astra.yaml');
    } finally {
      h.dispose();
    }
  });

  it('reports listing failures without dropping the project', async () => {
    const h = host();
    try {
      h.sessions!.failures.set('project/astra.yaml', new Error('offline'));
      request.mockImplementation(async (endpoint: string) => {
        if (endpoint.startsWith('api/materialization')) {
          throw new Error('no status');
        }
        return { papers: {} };
      });
      h.model.visible = true;
      await until(
        () => !!h.model.state.sessionsError && !!h.model.state.statusError
      );
      expect(h.model.state.sessionsError).toBe('offline');
      expect(h.model.state.statusError).toContain('no status');
      await until(() => !!h.model.state.data);
      expect(h.model.state.sessionsLoaded).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('follows the current widget to highlight sessions and records', async () => {
    const h = host();
    try {
      const chat = new FakeChatPanel('project/chats/hubble.chat');
      h.shell.currentWidget = chat;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view).toEqual({
        session: 'project/chats/hubble.chat'
      });
      const record = Object.assign(new Widget(), {
        lightconeView: true as const,
        entrypoint: 'project/astra.yaml',
        reference: { target: 'outputs.hubble_diagram' }
      });
      h.shell.currentWidget = record;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view.record?.target).toBe('outputs.hubble_diagram');
      const before = h.states.length;
      // The same widget again changes nothing.
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.states.length).toBe(before);
    } finally {
      h.dispose();
    }
  });

  it('follows a record tab that shows another record in place', async () => {
    const h = host();
    try {
      const historyChanged = new Signal<object, void>({});
      const record = Object.assign(new Widget(), {
        lightconeView: true as const,
        entrypoint: 'project/astra.yaml',
        reference: { target: 'outputs.hubble_diagram' },
        historyChanged
      });
      h.shell.currentWidget = record;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view.record?.target).toBe('outputs.hubble_diagram');
      // A link followed inside the tab keeps it current but shows a decision.
      record.reference.target = 'decisions.cosmological_model';
      historyChanged.emit();
      await flush();
      expect(h.model.state.view.record?.target).toBe(
        'decisions.cosmological_model'
      );
      // Once another widget is current, that tab's moves no longer matter.
      const chat = new FakeChatPanel('project/chats/hubble.chat');
      h.shell.currentWidget = chat;
      h.shell.currentChanged.emit({});
      await flush();
      const before = h.states.length;
      record.reference.target = 'outputs.cosmology_fit';
      historyChanged.emit();
      await flush();
      expect(h.states.length).toBe(before);
      expect(h.model.state.view).toEqual({
        session: 'project/chats/hubble.chat'
      });
    } finally {
      h.dispose();
    }
  });

  it('follows the analysis the inventory shows', async () => {
    const h = host();
    const context = createFileContext('project/astra.yaml');
    const inventory = new InventoryDocument(
      context,
      h.contents,
      new FakeThemeManager(),
      { openOrReveal: jest.fn() }
    );
    try {
      await inventory.content.display(
        { analysisPath: 'systematics' },
        'project/astra.yaml'
      );
      h.shell.currentWidget = inventory;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view).toEqual({
        inventory: 'project/astra.yaml',
        analysisPath: 'systematics'
      });
      // Choosing the root analysis inside the inventory moves the highlight.
      await inventory.content.display(
        { analysisPath: '$' },
        'project/astra.yaml'
      );
      await flush();
      expect(h.model.state.view.analysisPath).toBe('$');
    } finally {
      inventory.dispose();
      context.dispose();
      h.dispose();
    }
  });

  it('follows the current chat when its file is renamed', async () => {
    const h = host();
    try {
      const chat = new FakeChatPanel('project/chats/untitled.chat');
      h.shell.currentWidget = chat;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view.session).toBe('project/chats/untitled.chat');
      chat.rename('project/chats/hubble.chat');
      await flush();
      expect(h.model.state.view.session).toBe('project/chats/hubble.chat');
    } finally {
      h.dispose();
    }
  });

  it('renames a session file in its folder and refuses a taken name', async () => {
    const h = host({
      entries: {
        'project/chats/untitled.chat': fileModel('{}'),
        'project/chats/taken.chat': fileModel('{}')
      }
    });
    const rename = jest
      .spyOn(h.contents, 'rename')
      .mockImplementation(async (path, newPath) =>
        fileModel('', { path: newPath })
      );
    try {
      await expect(
        h.model.renameSession('project/chats/untitled.chat', 'Hubble fit')
      ).resolves.toBe('project/chats/hubble-fit.chat');
      expect(rename).toHaveBeenCalledWith(
        'project/chats/untitled.chat',
        'project/chats/hubble-fit.chat'
      );
      await expect(
        h.model.renameSession('project/chats/untitled.chat', 'Taken')
      ).rejects.toThrow('taken.chat already exists');
      await expect(
        h.model.renameSession('project/chats/untitled.chat', '  ')
      ).resolves.toBeUndefined();
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      h.dispose();
    }
  });

  it('works without sessions and stops after disposal', async () => {
    const h = host({ sessions: false });
    try {
      h.model.visible = true;
      await until(() => !!h.model.state.data);
      expect(h.model.sessionService).toBeNull();
      expect(h.model.state.sessionsLoaded).toBe(false);
      expect(h.model.activity(session({ activity: 'working' }))).toBe(
        'working'
      );
    } finally {
      h.dispose();
    }
    const count = h.states.length;
    h.current.set(null);
    await flush();
    expect(h.states.length).toBe(count);
    expect(h.model.isDisposed).toBe(true);
  });
});

describe('CoalescingRunner', () => {
  it('joins a run in flight, and runs again once for requests made during it', async () => {
    const releases: (() => void)[] = [];
    const update = jest.fn(
      () => new Promise<void>(resolve => releases.push(resolve))
    );
    const runner = new CoalescingRunner(update);
    const first = runner.run();
    expect(runner.run()).toBe(first);
    expect(update).toHaveBeenCalledTimes(1);
    void runner.request();
    void runner.request();
    releases[0]();
    await until(() => update.mock.calls.length === 2);
    releases[1]();
    await first;
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('reports a failure only when no newer request superseded it', async () => {
    let fail = true;
    const runner = new CoalescingRunner(async () => {
      if (fail) {
        fail = false;
        throw new Error('stale');
      }
    });
    await expect(runner.run()).rejects.toThrow('stale');
    fail = true;
    const running = runner.run();
    void runner.request();
    await expect(running).resolves.toBeUndefined();
  });

  it('runs again for a request made just after its last pass finished', async () => {
    let calls = 0;
    const runner = new CoalescingRunner(() => {
      calls += 1;
      const done = Promise.resolve();
      if (calls === 1) {
        // Two reactions later, the runner's pass is over, before anything
        // awaiting the run has resumed.
        void done
          .then(() => undefined)
          .then(() => {
            void runner.request();
          });
      }
      return done;
    });
    await runner.request();
    await flush();
    expect(calls).toBe(2);
  });

  it('recovers from an update that throws instead of rejecting', async () => {
    const update = jest.fn((): Promise<void> => {
      throw new Error('synchronous');
    });
    const runner = new CoalescingRunner(update);
    await expect(runner.run()).rejects.toThrow('synchronous');
    update.mockImplementation(async () => undefined);
    await expect(runner.run()).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
  });
});
