import { ServerConnection } from '@jupyterlab/services';
import { MySTRAViewer } from '../mystra-viewer';
import { IMySTRASession, readMySTRA } from '../api';

jest.mock('../api', () => ({
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
