import type { InventoryPaperMetadata } from '@astra-spec/ui/model';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { collectPaperMetadata, fetchPaper } from '../api';
import {
  acquireProjectDataService,
  type ProjectDataService,
  type IProjectDataState
} from '../project-data-service';
import { ProjectSubscription } from '../project-subscription';
import { analysis, createContents, fileModel } from './project-fixtures';

jest.mock('../api', () => ({
  collectPaperMetadata: jest.fn(),
  fetchPaper: jest.fn()
}));

/** Wait for an observable state transition rather than a polling timeout. */
function whenState(
  service: ProjectDataService,
  predicate: (state: IProjectDataState) => boolean
): Promise<void> {
  if (predicate(service.state)) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const changed = (
      _sender: ProjectDataService,
      state: IProjectDataState
    ): void => {
      if (predicate(state)) {
        service.changed.disconnect(changed);
        resolve();
      }
    };
    service.changed.connect(changed);
  });
}

beforeEach(() => {
  jest.mocked(collectPaperMetadata).mockReset().mockResolvedValue({});
  jest.mocked(fetchPaper).mockReset();
});

describe('shared project data', () => {
  it('shares normalized entrypoints and disposes only after the last release', () => {
    const { contents } = createContents({});
    const first = acquireProjectDataService(contents, './astra.yaml');
    const second = acquireProjectDataService(contents, 'astra.yaml');
    expect(first.service).toBe(second.service);
    first.release();
    first.release();
    expect(second.service.isDisposed).toBe(false);
    second.release();
    expect(second.service.isDisposed).toBe(true);
    contents.dispose();
  });

  it('retains valid data after malformed YAML, then recovers without re-emitting unchanged data', async () => {
    const model = fileModel(analysis('First'));
    const { contents } = createContents({ 'astra.yaml': model });
    const updates: IProjectDataState[] = [];
    const subscription = new ProjectSubscription(contents, state =>
      updates.push(state)
    );
    try {
      const first = await subscription.bind('astra.yaml');
      expect(first?.data?.document.analysis.name).toBe('First');
      await subscription.bind('./astra.yaml');
      expect(updates).toHaveLength(2);
      model.content = 'version: [';
      await subscription.refresh();
      expect(subscription.state.data).toBe(first?.data);
      expect(subscription.state.error).toBeTruthy();
      model.content = analysis('Recovered');
      await subscription.refresh();
      expect(subscription.state.error).toBeUndefined();
      expect(subscription.state.data?.document.analysis.name).toBe('Recovered');
    } finally {
      subscription.dispose();
      contents.dispose();
    }
  });

  it('publishes and refreshes project data while paper lookup is pending or failing', async () => {
    const paperLookup = new PromiseDelegate<
      Record<string, InventoryPaperMetadata>
    >();
    jest.mocked(collectPaperMetadata).mockReturnValue(paperLookup.promise);
    const model = fileModel(analysis('First'));
    const { contents } = createContents({ 'astra.yaml': model });
    const lease = acquireProjectDataService(contents);
    try {
      expect((await lease.service.get()).document.analysis.name).toBe('First');
      model.content = analysis('Updated');
      await lease.service.refresh();
      expect(lease.service.state.data?.document.analysis.name).toBe('Updated');
      expect(collectPaperMetadata).toHaveBeenCalledTimes(1);
      paperLookup.reject(new Error('Cache offline'));
      await paperLookup.promise.catch(() => undefined);
      jest
        .mocked(collectPaperMetadata)
        .mockRejectedValue(new Error('Cache offline'));
      const failed = whenState(lease.service, state =>
        Boolean(state.paperError)
      );
      await lease.service.refresh();
      await failed;
      expect(lease.service.state.error).toBeUndefined();
      expect(lease.service.state.paperError).toContain('Cache offline');
      expect(lease.service.state.data?.document.analysis.name).toBe('Updated');
    } finally {
      lease.release();
      contents.dispose();
    }
  });

  it('deduplicates paper downloads and protects completed metadata from older cache checks', async () => {
    const { contents } = createContents({
      'astra.yaml': fileModel(analysis('Papers'))
    });
    const lease = acquireProjectDataService(contents);
    const download = new PromiseDelegate<InventoryPaperMetadata>();
    const lookup = new PromiseDelegate<
      Record<string, InventoryPaperMetadata>
    >();
    jest.mocked(fetchPaper).mockReturnValue(download.promise);
    try {
      await lease.service.get();
      jest.mocked(collectPaperMetadata).mockReturnValue(lookup.promise);
      await lease.service.refresh();
      const first = lease.service.fetchPaper('10.1234/Example');
      const second = lease.service.fetchPaper(
        'https://doi.org/10.1234/example'
      );
      expect(fetchPaper).toHaveBeenCalledTimes(1);
      expect(lease.service.state.data?.papers['10.1234/example'].status).toBe(
        'fetching'
      );
      download.resolve({ title: 'Paper', pdfUrl: '/paper.pdf' });
      await Promise.all([first, second]);
      lookup.resolve({});
      await lookup.promise;
      expect(lease.service.state.data?.papers['10.1234/example']).toEqual({
        title: 'Paper',
        pdfUrl: '/paper.pdf',
        status: 'idle'
      });
    } finally {
      lease.release();
      contents.dispose();
    }
  });

  it('settles a disposed subscription without waiting for its pending request', async () => {
    const requested = new PromiseDelegate<void>();
    const blocked = new PromiseDelegate<void>();
    const { contents, get } = createContents({
      'astra.yaml': fileModel(analysis('Late'))
    });
    const original = get.getMockImplementation();
    get.mockImplementation(async (path, options) => {
      requested.resolve();
      await blocked.promise;
      return original!(path, options);
    });
    const updates: IProjectDataState[] = [];
    const subscription = new ProjectSubscription(contents, state =>
      updates.push(state)
    );
    try {
      const pending = subscription.bind('astra.yaml');
      await requested.promise;
      subscription.dispose();
      expect(await pending).toBeUndefined();
      expect(updates).toHaveLength(1);
      expect(await subscription.bind('astra.yaml')).toBeUndefined();
    } finally {
      blocked.resolve();
      subscription.dispose();
      contents.dispose();
    }
  });

  it('refreshes on scoped contents changes and disconnects when released', async () => {
    const model = fileModel(analysis('Before save'));
    const { contents } = createContents({ 'work/astra.yaml': model });
    const lease = acquireProjectDataService(contents, 'work/astra.yaml');
    const refresh = jest.spyOn(lease.service, 'refresh');
    try {
      await lease.service.get();
      refresh.mockClear();
      if (!(contents.fileChanged instanceof Signal)) {
        throw new Error('Expected the contents manager change signal.');
      }
      contents.fileChanged.emit({
        type: 'save',
        oldValue: null,
        newValue: { path: 'other/astra.yaml' }
      });
      expect(refresh).not.toHaveBeenCalled();
      model.content = analysis('After save');
      const updated = whenState(
        lease.service,
        state => state.data?.document.analysis.name === 'After save'
      );
      contents.fileChanged.emit({
        type: 'rename',
        oldValue: { path: 'work/old.csv' },
        newValue: { path: 'other/new.csv' }
      });
      await updated;
      expect(refresh).toHaveBeenCalledTimes(1);
      lease.release();
      contents.fileChanged.emit({
        type: 'save',
        oldValue: null,
        newValue: { path: 'work/astra.yaml' }
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      lease.release();
      contents.dispose();
    }
  });

  it('suppresses delivery from an old project after a subscription switches', async () => {
    const requested = new PromiseDelegate<void>();
    const blocked = new PromiseDelegate<void>();
    const { contents, get } = createContents({
      'old/astra.yaml': fileModel(analysis('Old')),
      'new/astra.yaml': fileModel(analysis('New'))
    });
    const original = get.getMockImplementation();
    get.mockImplementation(async (path, options) => {
      if (path.startsWith('old/')) {
        requested.resolve();
        await blocked.promise;
      }
      return original!(path, options);
    });
    const retained = acquireProjectDataService(contents, 'old/astra.yaml');
    const updates: IProjectDataState[] = [];
    const subscription = new ProjectSubscription(contents, state =>
      updates.push(state)
    );
    try {
      const old = subscription.bind('old/astra.yaml');
      await requested.promise;
      await subscription.bind('new/astra.yaml');
      blocked.resolve();
      expect(await old).toBeUndefined();
      expect(subscription.state.data?.document.analysis.name).toBe('New');
      expect(
        updates.some(state => state.data?.document.analysis.name === 'Old')
      ).toBe(false);
    } finally {
      blocked.resolve();
      subscription.dispose();
      retained.release();
      contents.dispose();
    }
  });
});

it('isolates pinned universes and refuses to silently change defaults or a deleted universe', async () => {
  const entries = { 'astra.yaml': fileModel(analysis('Universes')) } as Record<
    string,
    ReturnType<typeof fileModel>
  >;
  const { contents } = createContents(entries);
  const defaults = acquireProjectDataService(contents, 'astra.yaml', null);
  try {
    await defaults.service.get();
    entries['universes/baseline.yaml'] = fileModel('id: baseline\n');
    entries['universes/alternate.yaml'] = fileModel('id: alternate\n');
    await defaults.service.refresh();
    expect(defaults.service.state.error).toContain(
      'pinned to project defaults'
    );
    expect(defaults.service.state.data?.document.universe.source).toBe('none');
    const baseline = acquireProjectDataService(
      contents,
      'astra.yaml',
      'baseline'
    );
    const alternate = acquireProjectDataService(
      contents,
      'astra.yaml',
      'alternate'
    );
    try {
      expect(baseline.service).not.toBe(alternate.service);
      expect((await baseline.service.get()).document.universe.universeId).toBe(
        'baseline'
      );
      expect((await alternate.service.get()).document.universe.universeId).toBe(
        'alternate'
      );
      delete entries['universes/baseline.yaml'];
      await baseline.service.refresh();
      expect(baseline.service.state.error).toContain('baseline');
      expect(baseline.service.state.data?.document.universe.universeId).toBe(
        'baseline'
      );
    } finally {
      baseline.release();
      alternate.release();
    }
  } finally {
    defaults.release();
    contents.dispose();
  }
});
