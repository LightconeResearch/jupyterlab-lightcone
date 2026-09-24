import { ServerConnection } from '@jupyterlab/services';
import { StateDB } from '@jupyterlab/statedb';
import { PromiseDelegate } from '@lumino/coreutils';
import { requestAPI } from '../../request';
import type { IComputeListing, IEndedCluster } from '../compute-api';
import { ComputeModel, LAST_PRESET_KEY } from '../compute-model';
import { hostTarget, listing, slurmTarget } from './compute-fixtures';

jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
const request = jest.mocked(requestAPI);

const REGULAR = {
  label: 'Regular · 4 nodes · 2 h',
  backend: 'slurm' as const,
  nodes: 4
};

let models: ComputeModel[] = [];

function make(
  options: { state?: StateDB; onEnded?: (c: IEndedCluster) => void } = {}
) {
  const model = new ComputeModel({
    serverSettings: ServerConnection.makeSettings(),
    ...options
  });
  models.push(model);
  return model;
}

afterEach(() => {
  models.forEach(model => model.dispose());
  models = [];
  request.mockReset();
});

test('a refresh reads the listing for the current project', async () => {
  request.mockResolvedValue(listing([hostTarget()]));
  const model = make();
  let changes = 0;
  model.changed.connect(() => changes++);
  model.project = 'project/astra.yaml';
  await model.refresh();
  expect(request).toHaveBeenLastCalledWith(
    'api/compute?path=project%2Fastra.yaml',
    expect.anything()
  );
  expect(model.listing?.targets).toHaveLength(1);
  expect(model.error).toBeNull();
  expect(changes).toBeGreaterThan(0);
});

test('a failed refresh keeps the error and the last listing', async () => {
  request.mockResolvedValueOnce(listing([hostTarget()]));
  const model = make();
  await model.refresh();
  request.mockRejectedValueOnce(new Error('offline'));
  await model.refresh();
  expect(model.error).toContain('offline');
  expect(model.listing?.targets).toHaveLength(1);
});

test.each(['success', 'failure'])(
  'an older refresh %s cannot overwrite the latest listing',
  async outcome => {
    const older = new PromiseDelegate<IComputeListing>();
    request.mockReturnValueOnce(older.promise);
    const model = make();
    const first = model.refresh();
    const latest = listing([hostTarget({ active: false }), slurmTarget()]);
    request.mockResolvedValueOnce(latest);
    await model.refresh();
    if (outcome === 'success') {
      older.resolve(listing([hostTarget()]));
    } else {
      older.reject(new Error('stale error'));
    }
    await first;
    expect(model.listing).toEqual(latest);
    expect(model.error).toBeNull();
  }
);

test('a cluster that ends on its own is reported once, and only if it was seen', async () => {
  const ended: IEndedCluster[] = [];
  const model = make({ onEnded: cluster => ended.push(cluster) });
  const gone: IEndedCluster = {
    id: slurmTarget().id,
    backend: 'slurm',
    label: REGULAR.label,
    reason: 'reached its time limit'
  };
  // Ended before this model ever listed it: not news.
  request.mockResolvedValueOnce(
    listing([hostTarget()], { ended: [{ ...gone, id: 'older' }] })
  );
  await model.refresh();
  request.mockResolvedValueOnce(
    listing([hostTarget({ active: false }), slurmTarget()])
  );
  await model.refresh();
  request.mockResolvedValue(listing([hostTarget()], { ended: [gone] }));
  await model.refresh();
  await model.refresh();
  expect(ended).toEqual([gone]);
});

test('starting remembers the preset and offers it first', async () => {
  const state = new StateDB();
  request.mockImplementation(async (endpoint: string) =>
    endpoint === 'api/compute/clusters'
      ? slurmTarget({ state: 'queued' })
      : listing([hostTarget()])
  );
  const model = make({ state });
  const debug = { label: 'Debug', backend: 'slurm' as const };
  model.presets = [debug, REGULAR];
  await model.refresh();
  expect(model.offered.map(p => p.label)).toEqual(['Debug', REGULAR.label]);
  await model.start(REGULAR);
  expect(model.offered.map(p => p.label)).toEqual([REGULAR.label, 'Debug']);
  expect(await state.fetch(LAST_PRESET_KEY)).toBe(REGULAR.label);
  expect(model.pending).toBe(false);
});

test('a refused start leaves nothing pending and remembers nothing', async () => {
  request.mockImplementation(async (endpoint: string) => {
    if (endpoint === 'api/compute/clusters') {
      throw new Error('Slurm refused the cluster');
    }
    return listing([hostTarget()]);
  });
  const model = make();
  model.presets = [REGULAR];
  await expect(model.start(REGULAR)).rejects.toThrow('Slurm refused');
  expect(model.pending).toBe(false);
});

test('stopping asks the server and refreshes', async () => {
  request.mockResolvedValue(listing([hostTarget()]));
  const model = make();
  await model.stop(slurmTarget().id);
  expect(request).toHaveBeenCalledWith(
    `api/compute/clusters/${slurmTarget().id}`,
    expect.anything(),
    { method: 'DELETE' }
  );
  expect(request).toHaveBeenLastCalledWith('api/compute', expect.anything());
});

test('actions remain pending through their refresh and cannot overlap', async () => {
  const refresh = new PromiseDelegate<IComputeListing>();
  request.mockResolvedValueOnce(undefined).mockReturnValueOnce(refresh.promise);
  const model = make();
  const stopped = model.stop(slurmTarget().id);
  await Promise.resolve();
  await Promise.resolve();
  expect(model.pending).toBe(true);
  await expect(model.start(REGULAR)).rejects.toThrow('already in progress');
  expect(request.mock.calls.some(([, , init]) => init?.method === 'POST')).toBe(
    false
  );
  refresh.resolve(listing([hostTarget()]));
  await stopped;
  expect(model.pending).toBe(false);
});
