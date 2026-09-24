import { ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import {
  cancelRun,
  getRun,
  isJob,
  isJobEvent,
  isRunRecord,
  listRuns,
  startRun
} from '../runs-api';
import { startErrorMessage } from '../runs-model';
import { job, run } from './runs-fixtures';

const settings = ServerConnection.makeSettings({
  baseUrl: 'http://localhost:8888/lab/'
});

const ENTRYPOINT = 'project/astra.yaml';

/** Answer every request with this JSON body and status. */
function respond(body: unknown, status = 200) {
  return jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status
      })
  );
}

/** The URL and options of the only request made. */
function sent(request: ReturnType<typeof respond>): {
  url: URL;
  init: RequestInit;
} {
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  return { url: new URL(url), init };
}

beforeEach(() => {
  jest.restoreAllMocks();
});

test('narrows jobs, run records and job events', () => {
  expect(isJob(job())).toBe(true);
  expect(
    isJob(
      job({
        state: 'failed',
        finished: '2026-09-23T12:00:00Z',
        exit: 1,
        report: { ok: false }
      })
    )
  ).toBe(true);
  for (const bad of [
    null,
    { ...job(), state: 'wobbly' },
    { ...job(), lines: 'x' },
    { ...job(), refresh: 'no' },
    { ...job(), exit: '0' },
    { ...job(), report: [] },
    { ...job(), finished: undefined }
  ]) {
    expect(isJob(bad)).toBe(false);
  }
  expect(isRunRecord(run())).toBe(true);
  expect(isRunRecord(run({ exit: null }))).toBe(true);
  expect(isRunRecord({ ...run(), inputs: [1] })).toBe(false);
  expect(isRunRecord({ ...run(), universe: null })).toBe(false);
  expect(
    isJobEvent({ id: 'a', project: '', state: 'running', line: null })
  ).toBe(true);
  expect(isJobEvent({ id: 'a', project: '', state: 'running' })).toBe(false);
  expect(isJobEvent({ id: 'a', project: '', state: 'done', line: 'x' })).toBe(
    false
  );
});

test('lists runs and jobs of the project', async () => {
  const request = respond({ runs: [run()], jobs: [job()] });
  await expect(listRuns(settings, ENTRYPOINT)).resolves.toEqual({
    runs: [run()],
    jobs: [job()]
  });
  const { url } = sent(request);
  expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/runs');
  expect(url.searchParams.get('path')).toBe(ENTRYPOINT);
});

test('refuses a listing that breaks the contract', async () => {
  for (const body of [
    { runs: [run()] },
    { runs: [run()], jobs: [{ ...job(), state: 'wobbly' }] },
    { runs: [{ ...run(), cmd: 3 }], jobs: [] }
  ]) {
    jest.restoreAllMocks();
    respond(body);
    await expect(listRuns(settings, ENTRYPOINT)).rejects.toThrow(
      'The server returned an invalid run listing.'
    );
  }
});

test('starts a job with every target by default', async () => {
  const request = respond(job(), 202);
  await expect(startRun(settings, ENTRYPOINT)).resolves.toEqual(job());
  const { url, init } = sent(request);
  expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/runs');
  expect(url.search).toBe('');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({
    path: ENTRYPOINT,
    targets: [],
    refresh: false
  });
});

test('passes targets and refresh when starting a job', async () => {
  const request = respond(job({ targets: ['baseline/x'], refresh: true }));
  await startRun(settings, ENTRYPOINT, {
    targets: ['baseline/x'],
    refresh: true
  });
  expect(JSON.parse(String(sent(request).init.body))).toEqual({
    path: ENTRYPOINT,
    targets: ['baseline/x'],
    refresh: true
  });
});

test('keeps the status of a refused start', async () => {
  respond({ message: 'A materialization is already running.' }, 409);
  const error = await startRun(settings, ENTRYPOINT).then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(RequestError);
  expect(error instanceof RequestError && error.status).toBe(409);
  expect(startErrorMessage(error)).toMatch(/already running/);
});

test('reads and stops one job by its encoded id', async () => {
  let request = respond(job({ id: 'a/b' }));
  await expect(getRun(settings, ENTRYPOINT, 'a/b')).resolves.toEqual(
    job({ id: 'a/b' })
  );
  let { url, init } = sent(request);
  expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/runs/a%2Fb');
  expect(url.searchParams.get('path')).toBe(ENTRYPOINT);
  expect(init.method ?? 'GET').toBe('GET');

  jest.restoreAllMocks();
  request = respond(undefined, 204);
  await expect(cancelRun(settings, ENTRYPOINT, 'a/b')).resolves.toBeUndefined();
  ({ url, init } = sent(request));
  expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/runs/a%2Fb');
  expect(url.searchParams.get('path')).toBe(ENTRYPOINT);
  expect(init.method).toBe('DELETE');
});

test('refuses an invalid job', async () => {
  respond({ ...job(), lines: null });
  await expect(getRun(settings, ENTRYPOINT, 'job-1')).rejects.toThrow(
    'The server returned an invalid job.'
  );
  jest.restoreAllMocks();
  respond({ id: 'job-1' }, 202);
  await expect(startRun(settings, ENTRYPOINT)).rejects.toThrow(
    'The server returned an invalid job.'
  );
});

describe('where runs execute', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the venue and the invocation a listing reports', async () => {
    respond({
      runs: [run({ invocation: 'abc1234' })],
      jobs: [],
      venue: { slurm: true, nodes: 2 }
    });
    const listing = await listRuns(settings, ENTRYPOINT);
    expect(listing.venue).toEqual({ slurm: true, nodes: 2 });
    expect(listing.runs[0].invocation).toBe('abc1234');
    expect(isRunRecord({ ...run(), invocation: 3 })).toBe(false);
    jest.restoreAllMocks();
    respond({ runs: [], jobs: [], venue: { slurm: 'yes' } });
    await expect(listRuns(settings, ENTRYPOINT)).rejects.toThrow(
      'invalid run listing'
    );
  });
});
