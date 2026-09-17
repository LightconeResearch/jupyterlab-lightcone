import {
  parseMaterializationStatuses,
  outputMaterializationStatus
} from '../materialization-status';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { createContents, fileModel } from './project-fixtures';

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
