import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { SidebarModel, type ISidebarState } from '../sidebar-model';
import {
  FakeCommentService,
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

function host(options: { sessions?: boolean; comments?: boolean } = {}) {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC),
    'project/myst.yml': fileModel('project: {}'),
    'other/astra.yaml': fileModel(
      'version: "0.0.14"\nname: Other\ninputs: []\noutputs: []\n'
    )
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
  const comments = options.comments === false ? null : new FakeCommentService();
  comments?.counts.set('project/astra.yaml', 2);
  const shell = {
    currentWidget: null as Widget | null,
    currentChanged: new Signal<object, unknown>({})
  };
  const model = new SidebarModel({
    contents,
    shell,
    current,
    sessions,
    comments
  });
  const states: ISidebarState[] = [];
  model.changed.connect((_sender, state) => states.push(state));
  return {
    contents,
    current,
    sessions,
    comments,
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
  it('gathers project data, statuses, sessions, comments and the report', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(
        () =>
          !!h.model.state.data &&
          !!h.model.state.statuses &&
          h.model.state.sessionsLoaded &&
          h.model.state.reportAvailable
      );
      const state = h.model.state;
      expect(state.project?.entrypoint).toBe('project/astra.yaml');
      expect(state.data?.document.analysis.name).toBe('Sidebar project');
      expect(state.statuses?.['default/cosmology_fit'].state).toBe('behind');
      expect(state.sessions.map(item => item.title)).toEqual([
        'Hubble diagram with error bars',
        'Contour styling'
      ]);
      expect(state.pendingComments).toBe(2);
      expect(h.comments?.refresh).toHaveBeenCalledWith('project/astra.yaml');
      expect(state.error).toBeUndefined();
      expect(state.statusError).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it('prefers the live activity of an open chat and follows comment changes', async () => {
    const h = host();
    try {
      h.model.visible = true;
      await until(() => h.model.state.sessionsLoaded);
      const [first, second] = h.model.state.sessions;
      expect(h.model.activity(first)).toBe('idle');
      expect(h.model.activity(second)).toBe('working');
      h.sessions!.live.set(first.path, 'attention');
      expect(h.model.activity(first)).toBe('attention');
      h.comments!.counts.set('project/astra.yaml', 3);
      h.comments!.changed.emit('project/astra.yaml');
      await flush();
      expect(h.model.state.pendingComments).toBe(3);
      // Another project's comments do not count.
      h.comments!.counts.set('other/astra.yaml', 9);
      h.comments!.changed.emit('other/astra.yaml');
      await flush();
      expect(h.model.state.pendingComments).toBe(3);
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
      expect(h.model.state.pendingComments).toBe(0);
      expect(h.model.state.reportAvailable).toBe(false);
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
      const chat = Object.assign(new Widget(), {
        context: { path: 'project/chats/hubble.chat' }
      });
      h.shell.currentWidget = chat;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view).toEqual({
        session: 'project/chats/hubble.chat'
      });
      const record = Object.assign(new Widget(), {
        content: {
          reference: {
            entrypoint: 'project/astra.yaml',
            target: 'outputs.hubble_diagram'
          }
        }
      });
      record.title.dataset = { 'lightcone-element': record.id };
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
        content: {
          reference: {
            entrypoint: 'project/astra.yaml',
            target: 'outputs.hubble_diagram'
          },
          historyChanged
        }
      });
      record.title.dataset = { 'lightcone-element': record.id };
      h.shell.currentWidget = record;
      h.shell.currentChanged.emit({});
      await flush();
      expect(h.model.state.view.record?.target).toBe('outputs.hubble_diagram');
      // A link followed inside the tab keeps it current but shows a decision.
      record.content.reference.target = 'decisions.cosmological_model';
      historyChanged.emit();
      await flush();
      expect(h.model.state.view.record?.target).toBe(
        'decisions.cosmological_model'
      );
      // Once another widget is current, that tab's moves no longer matter.
      const chat = Object.assign(new Widget(), {
        context: { path: 'project/chats/hubble.chat' }
      });
      h.shell.currentWidget = chat;
      h.shell.currentChanged.emit({});
      await flush();
      const before = h.states.length;
      record.content.reference.target = 'outputs.cosmology_fit';
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

  it('works without sessions or comments and stops after disposal', async () => {
    const h = host({ sessions: false, comments: false });
    try {
      h.model.visible = true;
      await until(() => !!h.model.state.data);
      expect(h.model.sessionService).toBeNull();
      expect(h.model.state.sessionsLoaded).toBe(false);
      expect(h.model.state.pendingComments).toBe(0);
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
