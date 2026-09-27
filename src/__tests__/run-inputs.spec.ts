import { runInputRecord } from '../output-provenance';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { createContents, fileModel } from './project-fixtures';

jest.mock('../pdf-runtime', () => ({}));

const SPEC = `version: "0.0.14"
name: Upstream
inputs:
  - id: supernovae
    type: data
    source: data/supernovae.csv
outputs:
  - id: cosmology_fit
    type: table
    format: json
    inputs: [supernovae]
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [supernovae, cosmology_fit, checks.residuals]
analyses:
  checks:
    name: Checks
    inputs: []
    outputs:
      - id: residuals
        type: figure
        format: png
`;

test('finds each recorded input as the record it is, upstream outputs included', async () => {
  const { contents } = createContents({ 'astra.yaml': fileModel(SPEC) });
  try {
    const { bundle } = await resolveProject(contents);
    const { index, document } = assembleLoadedProject(bundle, {});
    const hubble = document.analysis.outputs.find(
      output => output.id === 'hubble_diagram'
    )!;
    const found = (id: string) => {
      const record = runInputRecord(index, hubble, id);
      return record && [record.kind, record.canonicalPath];
    };
    expect(found('supernovae')).toEqual(['input', 'inputs.supernovae']);
    // The run keys an upstream output by the id it is listed under.
    expect(found('cosmology_fit')).toEqual(['output', 'outputs.cosmology_fit']);
    expect(found('checks.residuals')).toEqual([
      'output',
      'checks.outputs.residuals'
    ]);
    expect(found('removed_since_the_run')).toBeUndefined();
  } finally {
    contents.dispose();
  }
});
