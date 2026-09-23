import { ServerConnection } from '@jupyterlab/services';
import { listRuns, type IRunListing } from '../../runs/runs-api';
import { CLOCK_SKEW_ALLOWANCE, cachedRuns } from '../runs-cache';

jest.mock('../../runs/runs-api', () => ({
  ...jest.requireActual('../../runs/runs-api'),
  listRuns: jest.fn()
}));

const SETTINGS = ServerConnection.makeSettings();
const LISTING: IRunListing = { runs: [], jobs: [] };

/** Browser time in seconds since the epoch. */
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now * 1000);
  jest.mocked(listRuns).mockReset().mockResolvedValue(LISTING);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('shares one request between footers of turns that ended long ago', async () => {
  const first = cachedRuns(SETTINGS, 'shared/astra.yaml', now - 3600);
  const second = cachedRuns(SETTINGS, 'shared/astra.yaml', now - 7200);
  expect(second).toBe(first);
  await expect(second).resolves.toBe(LISTING);
  expect(listRuns).toHaveBeenCalledTimes(1);
  expect(listRuns).toHaveBeenCalledWith(SETTINGS, 'shared/astra.yaml');
});

it('fetches again for a turn that ended after the cached request', () => {
  cachedRuns(SETTINGS, 'recent/astra.yaml', now - 3600);
  now += 5;
  cachedRuns(SETTINGS, 'recent/astra.yaml', now - 1);
  expect(listRuns).toHaveBeenCalledTimes(2);
});

it('does not trust a listing requested before the turn ended on a server whose clock is behind', () => {
  // A tool call's footer lists the runs as the tool starts...
  cachedRuns(SETTINGS, 'skew/astra.yaml', now - 10);
  // ...the run commits, and the closing message arrives two seconds later,
  // stamped by a server whose clock is ten seconds behind the browser's.
  now += 2;
  const serverEnd = now - 10;
  cachedRuns(SETTINGS, 'skew/astra.yaml', serverEnd);
  expect(listRuns).toHaveBeenCalledTimes(2);
  // A listing requested once the allowance has passed serves that turn.
  now = serverEnd + CLOCK_SKEW_ALLOWANCE;
  cachedRuns(SETTINGS, 'skew/astra.yaml', serverEnd);
  now += 1;
  cachedRuns(SETTINGS, 'skew/astra.yaml', serverEnd);
  expect(listRuns).toHaveBeenCalledTimes(3);
});

it('fetches again after thirty seconds', () => {
  cachedRuns(SETTINGS, 'ttl/astra.yaml');
  now += 29;
  cachedRuns(SETTINGS, 'ttl/astra.yaml');
  expect(listRuns).toHaveBeenCalledTimes(1);
  now += 2;
  cachedRuns(SETTINGS, 'ttl/astra.yaml');
  expect(listRuns).toHaveBeenCalledTimes(2);
});

it('forgets a failed request', async () => {
  jest.mocked(listRuns).mockRejectedValueOnce(new Error('offline'));
  await expect(cachedRuns(SETTINGS, 'failed/astra.yaml')).rejects.toThrow(
    'offline'
  );
  await expect(cachedRuns(SETTINGS, 'failed/astra.yaml')).resolves.toBe(
    LISTING
  );
  expect(listRuns).toHaveBeenCalledTimes(2);
});
