import {
  detailEntryForOpenReference,
  parseInventoryOpenReference
} from '../open-reference';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { createContents, fileModel } from './project-fixtures';

describe('inventory references', () => {
  it('rejects malformed command references', () => {
    for (const reference of [
      undefined,
      null,
      [],
      'reference',
      { kind: 'analysis', id: 'root' },
      { kind: 'paper', doi: ' ' }
    ]) {
      expect(parseInventoryOpenReference(reference)).toBeUndefined();
    }
    expect(parseInventoryOpenReference({ kind: 'output', id: 'plot' })).toEqual(
      {
        kind: 'output',
        id: 'plot'
      }
    );
  });

  it('does not resolve stale canonical paths or papers absent from the project', async () => {
    const { contents } = createContents({
      'astra.yaml': fileModel(
        'version: "0.0.14"\nname: Example\ninputs: []\noutputs:\n  - id: plot\n    type: figure\n    format: png\n'
      )
    });
    try {
      const { bundle } = await resolveProject(contents);
      const { index } = assembleLoadedProject(bundle, {});
      expect(
        detailEntryForOpenReference(index, { kind: 'output', id: 'plot' })
      ).toMatchObject({ canonicalPath: 'outputs.plot' });
      expect(
        detailEntryForOpenReference(index, {
          kind: 'output',
          id: 'plot',
          canonicalPath: 'deleted.outputs.plot'
        })
      ).toBeUndefined();
      expect(
        detailEntryForOpenReference(index, {
          kind: 'paper',
          doi: '10.1234/missing'
        })
      ).toBeUndefined();
    } finally {
      contents.dispose();
    }
  });
});
