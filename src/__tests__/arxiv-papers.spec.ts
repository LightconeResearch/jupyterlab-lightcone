import { collectPaperMetadata } from '../api';
import {
  arxivIdFromDoi,
  arxivPaperMetadata,
  arxivPdfUrl
} from '../arxiv-papers';
import { loadProjectPapers, resolveProject } from '../project-data';
import { createContents, fileModel } from './project-fixtures';
import { withLightconeServer } from './server-fixtures';

jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  collectPaperMetadata: jest.fn()
}));

const NEW_STYLE = '10.48550/arXiv.1807.06209';
const OLD_STYLE = '10.48550/arXiv.astro-ph/0604362';

const ROOT = `version: "0.0.14"
name: Papers
inputs: []
outputs: []
prior_insights:
  planck:
    claim: The CMB fixes the sound horizon.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: planck
        doi: ${NEW_STYLE}
        version: 1
      - id: journal
        doi: 10.1234/example
  classic:
    claim: An older survey agrees.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: classic
        doi: ${OLD_STYLE}
analyses:
  child:
    path: ./analyses/child
`;

const CHILD = `version: "0.0.14"
name: Child
inputs: []
outputs: []
prior_insights:
  later:
    claim: A later revision says more.
    created_at: "2026-01-02T00:00:00Z"
    evidence:
      - id: planck
        doi: ${NEW_STYLE}
        version: 3
`;

async function document() {
  const { contents } = createContents({
    'astra.yaml': fileModel(ROOT),
    'analyses/child/astra.yaml': fileModel(CHILD)
  });
  const { bundle } = await resolveProject(contents);
  return { contents, document: bundle.document };
}

describe('arxivIdFromDoi', () => {
  it('reads new- and old-style identifiers from arXiv DOIs', () => {
    expect(arxivIdFromDoi(NEW_STYLE)).toBe('1807.06209');
    expect(arxivIdFromDoi(OLD_STYLE)).toBe('astro-ph/0604362');
    expect(arxivIdFromDoi('10.48550/arXiv.math.GT/0309136')).toBe(
      'math.gt/0309136'
    );
    expect(arxivIdFromDoi('10.48550/arXiv.cond-mat.mes-hall/0507011')).toBe(
      'cond-mat.mes-hall/0507011'
    );
  });

  it('tolerates DOI URLs, labels and case', () => {
    expect(arxivIdFromDoi('https://doi.org/10.48550/ARXIV.2402.14070')).toBe(
      '2402.14070'
    );
    expect(arxivIdFromDoi('doi: 10.48550/arXiv.2402.14070')).toBe('2402.14070');
  });

  it('rejects every other DOI and malformed identifiers', () => {
    for (const doi of [
      '10.1234/example',
      '10.48550/arXiv.',
      '10.48550/arXiv.1807',
      '10.48550/arXiv.1807.06209/../pdf',
      '10.48550/arXiv.astro-ph/0604362v2',
      '10.48550/zenodo.1807.06209'
    ]) {
      expect(arxivIdFromDoi(doi)).toBeUndefined();
    }
  });
});

describe('arxivPdfUrl', () => {
  it('pins the cited revision when there is one', () => {
    expect(arxivPdfUrl(NEW_STYLE)).toBe('https://arxiv.org/pdf/1807.06209');
    expect(arxivPdfUrl(NEW_STYLE, 2)).toBe(
      'https://arxiv.org/pdf/1807.06209v2'
    );
    expect(arxivPdfUrl(OLD_STYLE, 1)).toBe(
      'https://arxiv.org/pdf/astro-ph/0604362v1'
    );
  });

  it('ignores revisions that are not positive integers', () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(arxivPdfUrl(NEW_STYLE, version)).toBe(
        'https://arxiv.org/pdf/1807.06209'
      );
    }
  });

  it('yields nothing for a DOI that is not on arXiv', () => {
    expect(arxivPdfUrl('10.1234/example')).toBeUndefined();
  });
});

describe('arxivPaperMetadata', () => {
  it('links every cited arXiv paper once, at the highest revision cited anywhere', async () => {
    const { contents, document: resolved } = await document();
    try {
      expect(arxivPaperMetadata(resolved)).toEqual({
        '10.48550/arxiv.1807.06209': {
          pdfUrl: 'https://arxiv.org/pdf/1807.06209v3'
        },
        '10.48550/arxiv.astro-ph/0604362': {
          pdfUrl: 'https://arxiv.org/pdf/astro-ph/0604362'
        }
      });
    } finally {
      contents.dispose();
    }
  });
});

describe('arxivPaperMetadata with an unpinned citation', () => {
  it('reads the latest revision, which an unpinned citation quotes', async () => {
    const { contents } = createContents({
      'astra.yaml': fileModel(`version: "0.0.14"
name: Papers
inputs: []
outputs: []
prior_insights:
  pinned:
    claim: The first revision says so.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: planck
        doi: ${NEW_STYLE}
        version: 1
  latest:
    claim: The latest revision says more.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: planck
        doi: ${NEW_STYLE}
`)
    });
    try {
      const { bundle } = await resolveProject(contents);
      expect(arxivPaperMetadata(bundle.document)).toEqual({
        '10.48550/arxiv.1807.06209': {
          pdfUrl: 'https://arxiv.org/pdf/1807.06209'
        }
      });
    } finally {
      contents.dispose();
    }
  });
});

describe('loadProjectPapers', () => {
  const cache = jest.mocked(collectPaperMetadata);
  beforeEach(() => cache.mockReset());

  it('reads arXiv papers from arXiv without Lightcone’s server', async () => {
    const { contents, document: resolved } = await document();
    try {
      expect(await loadProjectPapers(contents, resolved)).toEqual(
        arxivPaperMetadata(resolved)
      );
      expect(cache).not.toHaveBeenCalled();
    } finally {
      contents.dispose();
    }
  });

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    it('asks the paper cache for every cited paper', async () => {
      const { contents, document: resolved } = await document();
      cache.mockResolvedValue({});
      try {
        expect(await loadProjectPapers(contents, resolved)).toEqual({});
        expect(cache).toHaveBeenCalledWith(
          contents.serverSettings,
          expect.arrayContaining([
            '10.48550/arxiv.1807.06209',
            '10.1234/example',
            '10.48550/arxiv.astro-ph/0604362'
          ])
        );
      } finally {
        contents.dispose();
      }
    });
  });
});
