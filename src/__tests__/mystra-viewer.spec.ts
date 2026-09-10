import { ServerConnection } from '@jupyterlab/services';
import { MySTRAViewer } from '../mystra-viewer';
import { IMySTRASession, RequestError, readMySTRA } from '../api';

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
