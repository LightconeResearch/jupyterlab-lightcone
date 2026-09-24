import { Dialog, Notification } from '@jupyterlab/apputils';
import type { Contents, ContentsManager } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import { changeKind, ProjectNotifications } from '../project-notifications';
import {
  acquireProjectDataService,
  type IProjectDataLease
} from '../project-data-service';
import { analysis, createContents, fileModel } from './project-fixtures';

jest.mock('@jupyterlab/apputils', () => ({
  Notification: {
    emit: jest.fn(() => 'notification'),
    update: jest.fn(() => true),
    dismiss: jest.fn(),
    manager: { has: jest.fn(() => true) }
  },
  // The review stays open and has no stock buttons; only its body is read.
  Dialog: Object.assign(
    jest.fn(() => ({
      launch: () => new Promise(() => undefined),
      dispose: jest.fn(),
      resolve: jest.fn()
    })),
    { okButton: jest.fn(() => ({})) }
  ),
  showErrorMessage: jest.fn()
}));
const faults = { snapshot: 0 };
jest.mock('../project-changes', () => {
  const actual = jest.requireActual('../project-changes');
  return {
    ...actual,
    snapshotProject: (...args: unknown[]) => {
      if (faults.snapshot > 0) {
        faults.snapshot -= 1;
        throw new Error('snapshot failed');
      }
      return (actual.snapshotProject as (...a: unknown[]) => unknown)(...args);
    }
  };
});
jest.mock('../commands', () => ({
  CommandIDs: { openInventory: 'open-inventory', openElement: 'open-element' }
}));

interface IHarness {
  contents: ContentsManager;
  observer: ProjectNotifications;
  lease: IProjectDataLease;
  /** Rewrite the project, then let every live service re-resolve it. */
  write(name: string, leases?: IProjectDataLease[]): Promise<void>;
  /** Let a batch window elapse. */
  settle(): Promise<void>;
  open(universeId?: string | null): IProjectDataLease;
  dispose(): void;
}

/** A project with two universes, so per-universe grouping is observable. */
function harness(universes = false): IHarness {
  const entries: Record<string, Contents.IModel> = {
    'astra.yaml': fileModel(analysis('Initial')),
    ...(universes
      ? {
          'universes/alpha.yaml': fileModel('id: alpha\n'),
          'universes/beta.yaml': fileModel('id: beta\n')
        }
      : {})
  };
  const { contents } = createContents(entries);
  const observer = new ProjectNotifications(contents, new CommandRegistry());
  const leases: IProjectDataLease[] = [];
  const open = (universeId?: string | null) => {
    const lease = acquireProjectDataService(contents, 'astra.yaml', universeId);
    leases.push(lease);
    return lease;
  };
  const lease = open();
  return {
    contents,
    observer,
    lease,
    open,
    write: async (name, targets = leases) => {
      entries['astra.yaml'] = fileModel(analysis(name));
      const refreshed = targets.map(target => target.service.refresh());
      await jest.advanceTimersByTimeAsync(50);
      await Promise.all(refreshed);
      // Let the observer's hash pass and commit settle.
      await jest.advanceTimersByTimeAsync(50);
    },
    settle: () => jest.advanceTimersByTimeAsync(3100),
    dispose: () => {
      observer.dispose();
      for (const held of leases) held.release();
      contents.dispose();
    }
  };
}

let fixture: IHarness;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  faults.snapshot = 0;
});

afterEach(() => {
  fixture.dispose();
  jest.useRealTimers();
});

it('stays silent for the first resolution of a project', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  expect(Notification.emit).not.toHaveBeenCalled();
});

it('batches several edits into one notification naming the latest', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  await fixture.write('New name');
  await fixture.write('Final name');
  await fixture.settle();
  expect(Notification.emit).toHaveBeenCalledTimes(1);
  expect(Notification.emit).toHaveBeenCalledWith(
    '1 project change · Final name',
    'default',
    expect.objectContaining({ autoClose: 5000 })
  );
});

it('keeps a second view of the same project and universe on one notification', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  const second = fixture.open();
  expect(second.service).toBe(fixture.lease.service);
  await fixture.write('Edited once');
  await fixture.settle();
  expect(Notification.emit).toHaveBeenCalledTimes(1);
});

it('notifies each universe of a project separately', async () => {
  fixture = harness(true);
  const pinned = fixture.open('beta');
  expect(pinned.service).not.toBe(fixture.lease.service);
  await fixture.write('Initial');
  await fixture.settle();
  expect(Notification.emit).not.toHaveBeenCalled();
  await fixture.write('Edited once');
  await fixture.settle();
  // One outstanding notification per project/universe, not one shared update.
  expect(Notification.emit).toHaveBeenCalledTimes(2);
  expect(Notification.update).not.toHaveBeenCalled();
});

it('stops watching, and stays quiet on reopening, once the last view closes', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  fixture.lease.release();
  expect(fixture.lease.service.isDisposed).toBe(true);
  const reopened = fixture.open();
  expect(reopened.service).not.toBe(fixture.lease.service);
  // A real edit made while nothing was watching must not be announced.
  await fixture.write('Edited while closed', [reopened]);
  await fixture.settle();
  expect(Notification.emit).not.toHaveBeenCalled();
  expect(Notification.update).not.toHaveBeenCalled();
});

it('cancels a batch still waiting when the observer is disposed', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  await fixture.write('Edited once');
  // Dispose inside the batch window, before the notification is emitted.
  await jest.advanceTimersByTimeAsync(1000);
  expect(Notification.emit).not.toHaveBeenCalled();
  fixture.observer.dispose();
  await fixture.settle();
  expect(Notification.emit).not.toHaveBeenCalled();
  expect(Notification.update).not.toHaveBeenCalled();
});

it('keeps watching after a comparison fails', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  const failed = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    faults.snapshot = 1;
    await fixture.write('Edit that cannot be compared');
    await fixture.settle();
    expect(failed).toHaveBeenCalled();
    expect(Notification.emit).not.toHaveBeenCalled();
    // The next edit must still be reported; the failure cannot end the watch.
    await fixture.write('Edit after the failure');
    await fixture.settle();
    expect(Notification.emit).toHaveBeenCalledTimes(1);
  } finally {
    failed.mockRestore();
  }
});

it('names the kind mark of every kind of change row', () => {
  expect(
    ['project', 'subanalysis', 'output', 'result', 'decision'].map(changeKind)
  ).toEqual(['analysis', 'analysis', 'output', 'output', 'decision']);
  expect(['input', 'finding', 'insight', 'paper'].map(changeKind)).toEqual([
    'input',
    'finding',
    'prior_insight',
    'paper'
  ]);
  expect(changeKind('unknown')).toBeUndefined();
});

it('marks each row of the review with its kind, as the inventory does', async () => {
  fixture = harness();
  await fixture.write('Initial');
  await fixture.settle();
  await fixture.write('Renamed');
  await fixture.settle();
  const review = jest.mocked(Notification.emit).mock.calls[0][2]?.actions?.[0];
  review?.callback(new MouseEvent('click'));
  const body = jest.mocked(Dialog).mock.calls[0]?.[0]?.body;
  expect(isValidElement(body)).toBe(true);
  const node = document.createElement('div');
  const root = createRoot(node);
  const actEnvironment: unknown = Reflect.get(
    globalThis,
    'IS_REACT_ACT_ENVIRONMENT'
  );
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  try {
    act(() => root.render(isValidElement(body) ? body : null));
    const rows = Array.from(node.querySelectorAll('li'));
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('project changed')
    ]);
    expect(
      rows[0]
        .querySelector('span > .lightcone-brand.astra-ui > .astra-kind-glyph')
        ?.getAttribute('data-kind')
    ).toBe('analysis');
  } finally {
    act(() => root.unmount());
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
  }
});
