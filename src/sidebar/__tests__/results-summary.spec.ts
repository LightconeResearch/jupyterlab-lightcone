import { outputKindLabel } from '../../output-kind';
import { listOutputs } from '../../project-outputs';
import { nullTranslator } from '@jupyterlab/translation';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { resultsSummaryLabel, summarizeResults } from '../results-summary';
import { PROJECT_SPEC } from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

const TRANS = nullTranslator.load('jupyterlab_lightcone');

async function loadProject() {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC)
  });
  try {
    const { bundle } = await resolveProject(contents, 'project/astra.yaml');
    return assembleLoadedProject(bundle, {});
  } finally {
    contents.dispose();
  }
}

describe('results summary', () => {
  it('lists the results Home shows: active outputs of the root analysis', async () => {
    const data = await loadProject();
    const outputs = listOutputs(data);
    // Neither the output the universe does not make nor the child analysis's.
    expect(outputs.map(output => output.canonicalPath)).toEqual([
      'outputs.hubble_diagram',
      'outputs.cosmology_fit'
    ]);
    expect(
      data.index.recordByPath.get('outputs.curvature_posterior')
    ).toMatchObject({ active: false });
    expect(data.index.recordByPath.has('systematics.outputs.residuals')).toBe(
      true
    );
    expect(outputs.map(output => outputKindLabel(output.type, TRANS))).toEqual([
      'Figure',
      'Table'
    ]);
  });

  it('names output kinds the same way on Home and in the sidebar', () => {
    expect(
      ['figure', 'table', 'metric', 'data', 'report'].map(type =>
        outputKindLabel(type, TRANS)
      )
    ).toEqual(['Figure', 'Table', 'Metric', 'Data', 'Report']);
    expect(outputKindLabel('model', TRANS)).toBe('Model');
    expect(outputKindLabel(undefined, TRANS)).toBe('Output');
  });

  it('counts outputs per state and labels the header', async () => {
    const data = await loadProject();
    const outputs = listOutputs(data);
    const summary = summarizeResults(outputs, output =>
      output.canonicalPath === 'outputs.cosmology_fit'
        ? { state: 'behind', detail: '' }
        : undefined
    );
    expect(summary).toEqual({
      total: 2,
      current: 0,
      behind: 1,
      stale: 0,
      unknown: 1
    });
    const label = (
      statusFor: Parameters<typeof summarizeResults>[1],
      subject = outputs
    ) => resultsSummaryLabel(summarizeResults(subject, statusFor), TRANS);
    expect(resultsSummaryLabel(summary, TRANS)).toBe('1 behind');
    expect(
      label(output =>
        output.canonicalPath === 'outputs.hubble_diagram'
          ? { state: 'current' }
          : { state: 'behind' }
      )
    ).toBe('1 ✓ · 1 behind');
    expect(label(() => undefined)).toBe('2');
    expect(label(() => ({ state: 'current' }))).toBe('2 ✓');
    expect(label(() => ({ state: 'stale' }))).toBe('2 stale');
    expect(label(() => undefined, [])).toBe('0');
  });
});
