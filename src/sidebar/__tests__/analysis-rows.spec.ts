import { nullTranslator } from '@jupyterlab/translation';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  analysisCounts,
  analysisCountsLabel,
  analysisRows
} from '../analysis-rows';
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

describe('analysis rows', () => {
  it('flattens the analysis tree with counts, root first', async () => {
    const data = await loadProject();
    const rows = analysisRows(data);
    expect(rows.map(row => [row.canonicalPath, row.depth])).toEqual([
      ['$', 0],
      ['systematics', 1]
    ]);
    // Every declared output counts, as in the inventory's sections.
    expect(rows[0]).toMatchObject({
      title: 'Sidebar project',
      outputs: 3,
      decisions: 1,
      inputs: 1,
      findings: 1,
      papers: 1
    });
    expect(analysisCountsLabel(rows[0], TRANS)).toBe(
      'Outputs 3 · Decisions 1 · Inputs 1 · Findings 1 · Papers 1'
    );
    expect(analysisCounts(rows[0], TRANS).map(entry => entry.kind)).toEqual([
      'output',
      'decision',
      'input',
      'finding',
      'paper'
    ]);
    // A child analysis with only outputs is not empty.
    expect(analysisCountsLabel(rows[1], TRANS)).toBe('Outputs 1');
    expect(rows[1].title).toBe('Systematics');
    expect(analysisCountsLabel({ ...rows[1], outputs: 0 }, TRANS)).toBe(
      'No records yet'
    );
  });
});
