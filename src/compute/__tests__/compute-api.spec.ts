import { ServerConnection } from '@jupyterlab/services';
import { requestAPI } from '../../request';
import {
  fetchCompute,
  isComputeListing,
  isComputeTarget,
  startCluster,
  stopCluster
} from '../compute-api';
import { hostTarget, listing, slurmTarget } from './compute-fixtures';

jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
const request = jest.mocked(requestAPI);
const settings = ServerConnection.makeSettings();

afterEach(() => request.mockReset());

test('a listing names the format, the backends and every target', () => {
  expect(isComputeListing(listing([hostTarget(), slurmTarget()]))).toBe(true);
  expect(isComputeListing({ ...listing([]), backends: ['pbs'] })).toBe(false);
  expect(isComputeListing({ ...listing([]), attaches: 'yes' })).toBe(false);
  expect(isComputeListing({ ...listing([]), ended: [{ id: 'x' }] })).toBe(
    false
  );
});

test('targets are checked field by field', () => {
  expect(isComputeTarget(hostTarget())).toBe(true);
  expect(isComputeTarget(slurmTarget())).toBe(true);
  expect(isComputeTarget({ ...hostTarget(), state: 'sleeping' })).toBe(false);
  expect(isComputeTarget({ ...hostTarget(), variant: 'laptop' })).toBe(false);
  expect(isComputeTarget({ ...slurmTarget(), load: { workers: 1 } })).toBe(
    false
  );
  expect(isComputeTarget({ ...slurmTarget(), details: [1] })).toBe(false);
  expect(isComputeTarget({ ...hostTarget(), size: null })).toBe(false);
});

test('the listing is read for the current project, or for none', async () => {
  request.mockResolvedValue(listing([hostTarget()]));
  await fetchCompute(settings, 'project/astra.yaml');
  expect(request).toHaveBeenLastCalledWith(
    'api/compute?path=project%2Fastra.yaml',
    settings
  );
  await fetchCompute(settings, null);
  expect(request).toHaveBeenLastCalledWith('api/compute', settings);
});

test('an invalid listing is an error that names the service', async () => {
  request.mockResolvedValue({ targets: 'none' });
  await expect(fetchCompute(settings, null)).rejects.toThrow(
    'Compute request failed: The server returned an invalid compute listing.'
  );
});

test('starting sends the preset and the project', async () => {
  request.mockResolvedValue(slurmTarget({ state: 'queued', load: null }));
  const preset = { label: 'Debug', backend: 'slurm' as const, nodes: 1 };
  const target = await startCluster(settings, preset, 'project/astra.yaml');
  expect(target.state).toBe('queued');
  const [endpoint, , init] = request.mock.calls[0];
  expect(endpoint).toBe('api/compute/clusters');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({
    preset,
    path: 'project/astra.yaml'
  });
});

test('stopping deletes the cluster by id', async () => {
  request.mockResolvedValue(undefined);
  await stopCluster(settings, '20260924-141502-k3x9');
  expect(request).toHaveBeenCalledWith(
    'api/compute/clusters/20260924-141502-k3x9',
    settings,
    { method: 'DELETE' }
  );
});
