import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  fetchMaterializationStatuses,
  parseMaterializationStatuses
} from '../materialization-api';
import {
  outputMaterializationStatus,
  useMaterializationStatus
} from '../materialization-status';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { analysis, createContents, fileModel } from './project-fixtures';
import { withLightconeServer } from './server-fixtures';

jest.mock('../materialization-api', () => ({
  ...jest.requireActual('../materialization-api'),
  fetchMaterializationStatuses: jest.fn()
}));

it('rejects unavailable or malformed reports rather than showing successful checks', () => {
  for (const payload of [
    null,
    {},
    { outputs: [] },
    { outputs: { a: { state: 'outdated', detail: '' } } }
  ]) {
    expect(() => parseMaterializationStatuses(payload)).toThrow();
  }
});

it('uses the selected universe instead of matching output IDs across universes', async () => {
  const { contents } = createContents({
    'astra.yaml': fileModel(
      "version: '0.0.14'\nname: Status\ninputs: []\noutputs:\n  - id: result\n    type: data\n    format: json\n"
    )
  });
  try {
    const { bundle } = await resolveProject(contents, 'astra.yaml');
    const data = assembleLoadedProject(bundle, {});
    const output = data.document.analysis.outputs[0];
    const statuses = parseMaterializationStatuses({
      outputs: {
        'default/result': { state: 'stale', detail: 'Input changed' },
        'other/result': { state: 'current', detail: '' }
      }
    });
    expect(outputMaterializationStatus(statuses, data, output)?.state).toBe(
      'stale'
    );
    expect(
      outputMaterializationStatus(undefined, data, output)
    ).toBeUndefined();
  } finally {
    contents.dispose();
  }
});

describe('useMaterializationStatus', () => {
  const fetchStatuses = jest.mocked(fetchMaterializationStatuses);
  beforeEach(() => fetchStatuses.mockReset());

  /** The hook's result for a project, once its first check has settled. */
  async function status(): Promise<
    ReturnType<typeof useMaterializationStatus>
  > {
    const { contents } = createContents({
      'astra.yaml': fileModel(analysis('Status'))
    });
    const { bundle } = await resolveProject(contents);
    let result: ReturnType<typeof useMaterializationStatus> = {};
    function Probe(): null {
      result = useMaterializationStatus(
        contents,
        'astra.yaml',
        bundle.document
      );
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(React.createElement(Probe)));
    // The poll's first check starts on a later tick.
    for (let tick = 0; tick < 20 && !fetchStatuses.mock.calls.length; tick++) {
      await act(() => new Promise(resolve => setTimeout(resolve, 25)));
    }
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    act(() => root.unmount());
    contents.dispose();
    return result;
  }

  it('asks nothing and reports no error without Lightcone’s server', async () => {
    expect(await status()).toEqual({});
    expect(fetchStatuses).not.toHaveBeenCalled();
  });

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    it('reports what `lc status` says', async () => {
      fetchStatuses.mockResolvedValue({});
      expect(await status()).toEqual(expect.objectContaining({ statuses: {} }));
      expect(fetchStatuses).toHaveBeenCalledWith(
        expect.anything(),
        'astra.yaml'
      );
    });
  });
});
