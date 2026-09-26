import { ServerConnection } from '@jupyterlab/services';
import { listResultsCommits } from '../../versions/versions-api';
import { ResultsHistoryCache, RESULTS_CACHE_TTL } from '../results-cache';

jest.mock('../../versions/versions-api', () => ({
  listResultsCommits: jest.fn()
}));

const entrypoint = 'project/astra.yaml';
let cache: ResultsHistoryCache;
let clock: jest.SpyInstance<number, []>;

beforeEach(() => {
  jest.mocked(listResultsCommits).mockReset().mockResolvedValue([]);
  clock = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  cache = new ResultsHistoryCache(ServerConnection.makeSettings());
});

afterEach(() => {
  cache.dispose();
  clock.mockRestore();
});

test('older reply footers share history until it expires', async () => {
  const first = cache.get(entrypoint, 800);
  expect(cache.get(entrypoint, 850)).toBe(first);
  await first;
  expect(listResultsCommits).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(1_000_000 + RESULTS_CACHE_TTL);
  expect(cache.get(entrypoint, 850)).not.toBe(first);
  expect(listResultsCommits).toHaveBeenCalledTimes(2);
});

test('a recent reply refreshes a cached listing that could predate its run', async () => {
  const beforeReply = cache.get(entrypoint, 800);
  await beforeReply;
  expect(cache.get(entrypoint, 990)).not.toBe(beforeReply);
  expect(listResultsCommits).toHaveBeenCalledTimes(2);
});

test('a rejected old request cannot discard a newer successful listing', async () => {
  let reject: (reason: Error) => void = () => undefined;
  jest.mocked(listResultsCommits).mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      })
  );
  const old = cache.get(entrypoint, 800);
  const fresh = cache.get(entrypoint, 990);
  await fresh;
  reject(new Error('old request failed'));
  await expect(old).rejects.toThrow('old request failed');
  expect(cache.get(entrypoint, 800)).toBe(fresh);
  expect(listResultsCommits).toHaveBeenCalledTimes(2);
});
