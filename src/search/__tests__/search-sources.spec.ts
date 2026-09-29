import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { ContentsManager } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { collectPaperMetadata } from '../../api';
import {
  observeProjectDataServices,
  type ProjectDataService
} from '../../project-data-service';
import type {
  ISessionService,
  SessionState
} from '../../sessions/session-service';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { FILE_LISTING_TTL, SearchSources } from '../search-sources';
import type { IRecordsUpdate } from '../search-sources';
import { withLightconeServer } from '../../__tests__/server-fixtures';

// These behaviors belong to the full install, with Lightcone's server routes.
withLightconeServer();

// Jest does not transform Jupyter Chat's ES modules; only its icon is used.
jest.mock('@jupyter/chat', () => ({ chatIcon: { name: 'chat' } }));
jest.mock('../../api', () => ({
  ...jest.requireActual('../../api'),
  collectPaperMetadata: jest.fn(),
  fetchPaper: jest.fn()
}));

const SPEC = `version: '0.0.14'
name: Project
inputs: []
outputs:
  - id: fit
    label: Cosmology fit
    type: metric
    format: json
prior_insights:
  source:
    claim: Earlier result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: paper
        doi: 10.1234/example
`;

const PROJECT = { path: 'work', entrypoint: 'work/astra.yaml' };
const TRANS = nullTranslator.load('jupyterlab_lightcone');

function app(contents: ContentsManager): JupyterFrontEnd {
  return {
    commands: new CommandRegistry(),
    serviceManager: { contents },
    docRegistry: { getFileTypesForPath: () => [] }
  } as unknown as JupyterFrontEnd;
}

function fixture() {
  return createContents({
    'work/astra.yaml': fileModel(SPEC),
    'work/notes.md': fileModel('notes'),
    'work/src/plot.py': fileModel('print(1)'),
    'other/astra.yaml': fileModel(SPEC)
  });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition instead of a fixed delay. */
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for the search sources.');
    }
    await flush();
  }
}

beforeEach(() => {
  jest.mocked(collectPaperMetadata).mockReset().mockResolvedValue({});
});

describe('SearchSources', () => {
  it('shares one walk between concurrent openings and reuses it for 30 s', async () => {
    const { contents, get } = fixture();
    const sources = new SearchSources(app(contents), null, [], TRANS);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const [first, second] = await Promise.all([
        sources.listFiles(PROJECT),
        sources.listFiles(PROJECT)
      ]);
      const walked = () =>
        get.mock.calls.filter(([, options]) => options?.type === 'directory')
          .length;
      expect(first.map(candidate => candidate.label)).toEqual([
        'astra.yaml',
        'notes.md',
        'plot.py'
      ]);
      expect(second).toEqual(first);
      expect(walked()).toBe(2);

      now.mockReturnValue(1_000_000 + FILE_LISTING_TTL - 1);
      await sources.listFiles(PROJECT);
      expect(walked()).toBe(2);

      now.mockReturnValue(1_000_000 + FILE_LISTING_TTL + 1);
      await sources.listFiles(PROJECT);
      expect(walked()).toBe(4);
    } finally {
      now.mockRestore();
      sources.dispose();
      contents.dispose();
    }
  });

  it('lists sessions with their live activity, and none without the service', async () => {
    const { contents } = fixture();
    const info: ISessionInfo = {
      path: 'work/chats/hubble.chat',
      title: 'Hubble diagram',
      modified: new Date().toISOString(),
      messages: 2,
      lastAgent: 'Codex',
      activity: 'idle'
    };
    const service: ISessionService = {
      list: jest.fn().mockResolvedValue([info]),
      createAndOpen: jest.fn(),
      openSession: jest.fn(),
      changed: new Signal<ISessionService, string>({} as ISessionService),
      activity: (): SessionState => 'attention'
    };
    const withSessions = new SearchSources(app(contents), service, [], TRANS);
    const without = new SearchSources(app(contents), null, [], TRANS);
    try {
      const [session] = await withSessions.listSessions(PROJECT);
      expect(service.list).toHaveBeenCalledWith('work/astra.yaml');
      expect(session.label).toBe('Hubble diagram');
      expect(session.caption).toBe('Codex · needs your input · now');
      expect(without.hasSessions).toBe(false);
      expect(await without.listSessions(PROJECT)).toEqual([]);
    } finally {
      withSessions.dispose();
      without.dispose();
      contents.dispose();
    }
  });

  it('holds the project data while it is searched and announces paper titles', async () => {
    const { contents } = fixture();
    const papers = new PromiseDelegate<
      Awaited<ReturnType<typeof collectPaperMetadata>>
    >();
    jest.mocked(collectPaperMetadata).mockReturnValueOnce(papers.promise);
    const services: ProjectDataService[] = [];
    const observing = observeProjectDataServices(contents, service => {
      services.push(service);
    });
    const sources = new SearchSources(app(contents), null, [], TRANS);
    const updates: IRecordsUpdate[] = [];
    sources.recordsChanged.connect((_sender, update) => {
      updates.push(update);
    });
    const paperLabel = (candidates: IRecordsUpdate['candidates']) =>
      candidates.find(candidate => candidate.kind === 'paper')?.label;
    try {
      const first = await sources.listRecords(PROJECT);
      expect(paperLabel(first)).toBe('10.1234/example');
      expect(services).toHaveLength(1);
      expect(services[0].isDisposed).toBe(false);

      // The paper cache answers after the first listing: the held service
      // keeps it and the new title is announced.
      const announced = updates.length;
      papers.resolve({
        '10.1234/example': { title: 'An example paper', authors: 'A. Author' }
      });
      await until(() => updates.length > announced);
      const update = updates[updates.length - 1];
      expect(update.entrypoint).toBe('work/astra.yaml');
      expect(paperLabel(update.candidates)).toBe('An example paper');

      // The same project reuses the held service.
      expect(paperLabel(await sources.listRecords(PROJECT))).toBe(
        'An example paper'
      );
      expect(services).toHaveLength(1);

      sources.keepRecordsFor('work/astra.yaml');
      expect(services[0].isDisposed).toBe(false);
      sources.keepRecordsFor('other/astra.yaml');
      expect(services[0].isDisposed).toBe(true);

      await sources.listRecords({
        path: 'other',
        entrypoint: 'other/astra.yaml'
      });
      expect(services).toHaveLength(2);
      sources.dispose();
      expect(services[1].isDisposed).toBe(true);
    } finally {
      observing.dispose();
      sources.dispose();
      contents.dispose();
    }
  });
});
