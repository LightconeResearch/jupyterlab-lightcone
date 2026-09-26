import { ServerConnection } from '@jupyterlab/services';
import { WidgetTracker } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import { MySTRAViewer } from '../mystra-viewer';
import {
  IMySTRASession,
  RequestError,
  readMySTRA,
  startMySTRA,
  stopMySTRA
} from '../api';

// Keep the real RequestError so the viewer can branch on HTTP status.
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  readMySTRA: jest.fn(),
  startMySTRA: jest.fn(),
  stopMySTRA: jest.fn()
}));

const session: IMySTRASession = {
  id: 'a'.repeat(32),
  path: 'project/myst.yml',
  state: 'starting',
  message: 'Starting MySTRA…',
  logs: [],
  url: `/user/alice/jupyterlab_lightcone/mystra/${'a'.repeat(32)}/site/`
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('activation focuses the viewer so shell commands target its tab', () => {
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  Widget.attach(widget, document.body);
  try {
    widget.activate();
    MessageLoop.flush();
    expect(document.activeElement).toBe(widget.node);
  } finally {
    widget.dispose();
  }
});

test('closing the tab disposes it, removes it from the tracker and stops heartbeats', async () => {
  const tracker = new WidgetTracker<MySTRAViewer>({ namespace: 'mystra-test' });
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  Widget.attach(widget, document.body);
  await tracker.add(widget);
  try {
    widget.close();
    expect(widget.isDisposed).toBe(true);
    expect(widget.isAttached).toBe(false);
    expect(tracker.size).toBe(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(readMySTRA).not.toHaveBeenCalled();
    // Other browser views may still lease the same server process.
    expect(stopMySTRA).not.toHaveBeenCalled();
  } finally {
    widget.dispose();
    tracker.dispose();
  }
});

test('loads the iframe only after readiness and stops polling on disposal', async () => {
  const read = jest.mocked(readMySTRA);
  read.mockResolvedValue({ ...session, state: 'ready', message: 'Ready' });
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  const frame = widget.node.querySelector('iframe');
  expect(frame?.getAttribute('src')).toBeNull();
  await jest.advanceTimersByTimeAsync(1000);
  expect(frame?.getAttribute('src')).toBe(session.url);
  expect(widget.node.querySelector('[role="status"]')?.textContent).toBe(
    'Ready'
  );
  widget.dispose();
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(1);
});

test('preserves the rendered document when a heartbeat fails', async () => {
  jest.mocked(readMySTRA).mockRejectedValue(new Error('Connection lost'));
  const widget = new MySTRAViewer(
    { ...session, state: 'ready' },
    ServerConnection.makeSettings()
  );
  await jest.advanceTimersByTimeAsync(15000);
  expect(widget.node.querySelector('iframe')?.getAttribute('src')).toBe(
    session.url
  );
  expect(widget.node.querySelector('[role="status"]')?.textContent).toContain(
    'Connection lost'
  );
  widget.dispose();
});

test('stops polling an expired session until a new one is adopted', async () => {
  const read = jest.mocked(readMySTRA);
  const response = new Response('Not Found', { status: 404 });
  read.mockRejectedValue(
    new RequestError(
      'MySTRA',
      new ServerConnection.ResponseError(response, 'Not Found')
    )
  );
  const widget = new MySTRAViewer(
    { ...session, state: 'ready' },
    ServerConnection.makeSettings()
  );
  await jest.advanceTimersByTimeAsync(15000);
  expect(widget.node.querySelector('[role="status"]')?.textContent).toContain(
    'expired'
  );
  await jest.advanceTimersByTimeAsync(60000);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ ...session, id: 'b'.repeat(32), state: 'ready' });
  widget.adopt({ ...session, id: 'b'.repeat(32), state: 'ready' });
  await jest.advanceTimersByTimeAsync(15000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(expect.anything(), 'b'.repeat(32));
  widget.dispose();
});

test('ignores a heartbeat that finishes after closing the tab', async () => {
  let complete!: (value: IMySTRASession) => void;
  jest.mocked(readMySTRA).mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    })
  );
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  await jest.advanceTimersByTimeAsync(1000);
  widget.close();
  complete({ ...session, state: 'ready' });
  await jest.advanceTimersByTimeAsync(60000);
  expect(widget.isDisposed).toBe(true);
  expect(readMySTRA).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('restart replaces the session and ignores the previous heartbeat', async () => {
  let complete!: (value: IMySTRASession) => void;
  const read = jest.mocked(readMySTRA);
  read.mockReturnValueOnce(
    new Promise(resolve => {
      complete = resolve;
    })
  );
  const next = { ...session, id: 'b'.repeat(32), url: '/next/site/' };
  jest.mocked(stopMySTRA).mockResolvedValue(undefined);
  jest.mocked(startMySTRA).mockResolvedValue(next);
  read.mockResolvedValue({ ...next, state: 'ready' });
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  try {
    await jest.advanceTimersByTimeAsync(1000);
    await widget.restartSession();
    complete({ ...session, state: 'ready' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(stopMySTRA).toHaveBeenCalledWith(expect.anything(), session.id);
    expect(read).toHaveBeenLastCalledWith(expect.anything(), next.id);
    expect(widget.node.querySelector('iframe')?.getAttribute('src')).toBe(
      next.url
    );
  } finally {
    widget.dispose();
  }
});

test('closing during stop does not launch a replacement process', async () => {
  let stopped!: () => void;
  jest.mocked(stopMySTRA).mockReturnValue(
    new Promise(resolve => {
      stopped = resolve;
    })
  );
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  const restarting = widget.restartSession();
  widget.close();
  stopped();
  await restarting;
  expect(startMySTRA).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('closing during startup does not revive the tab or its heartbeat', async () => {
  let started!: (value: IMySTRASession) => void;
  jest.mocked(stopMySTRA).mockResolvedValue(undefined);
  jest.mocked(startMySTRA).mockReturnValue(
    new Promise(resolve => {
      started = resolve;
    })
  );
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  const restarting = widget.restartSession();
  await jest.advanceTimersByTimeAsync(0);
  widget.close();
  started({ ...session, id: 'b'.repeat(32) });
  await restarting;
  expect(widget.isDisposed).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('a failed restart can be retried', async () => {
  jest.mocked(stopMySTRA).mockResolvedValue(undefined);
  const start = jest.mocked(startMySTRA);
  start.mockRejectedValueOnce(new Error('Startup failed'));
  start.mockResolvedValue({
    ...session,
    id: 'b'.repeat(32),
    state: 'ready',
    url: '/retry/site/'
  });
  const widget = new MySTRAViewer(session, ServerConnection.makeSettings());
  try {
    await widget.restartSession();
    expect(widget.node.querySelector('[role="status"]')?.textContent).toContain(
      'Startup failed'
    );
    await widget.restartSession();
    expect(widget.node.querySelector('iframe')?.getAttribute('src')).toBe(
      '/retry/site/'
    );
  } finally {
    widget.dispose();
  }
});
