import {
  detailEntryForOpenReference,
  parseInventoryOpenReference,
  publicationReference,
  publicationUrl
} from '../open-reference';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { createContents, fileModel } from './project-fixtures';

describe('publication references', () => {
  it('rejects malformed cross-frame messages', () => {
    for (const data of [
      undefined,
      null,
      [],
      'message',
      { type: 'other' },
      {
        type: 'astra:open-reference',
        reference: { kind: 'analysis', id: 'root' }
      }
    ]) {
      expect(publicationReference(data)).toBeUndefined();
    }
    expect(
      publicationReference({
        type: 'astra:open-reference',
        reference: { kind: 'output', id: 'plot' }
      })
    ).toEqual({ kind: 'output', id: 'plot' });
    expect(
      parseInventoryOpenReference({ kind: 'paper', doi: ' ' })
    ).toBeUndefined();
  });

  it('accepts HTTP(S) publication URLs and rejects executable or credentialed URLs', () => {
    expect(publicationUrl('/paper', 'https://example.org/lab').href).toBe(
      'https://example.org/paper'
    );
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,paper',
      'file:///paper',
      'https://user:secret@example.org'
    ]) {
      expect(() => publicationUrl(value, 'https://example.org')).toThrow(
        'HTTP or HTTPS'
      );
    }
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
