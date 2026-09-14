import { Notification } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { ProjectNotifications } from '../project-notifications';
import {
  projectDataUpdated,
  projectDataDisposed
} from '../project-data-service';
import { assembleLoadedProject, resolveProject } from '../project-data';
import { analysis, createContents, fileModel } from './project-fixtures';

jest.mock('@jupyterlab/apputils', () => ({
  Notification: {
    emit: jest.fn(() => 'notification'),
    update: jest.fn(() => true),
    dismiss: jest.fn(),
    manager: { notifications: [{ id: 'notification' }] }
  },
  Dialog: jest.fn(),
  showErrorMessage: jest.fn()
}));
jest.mock('../commands', () => ({
  CommandIDs: { openInventory: 'open-inventory' }
}));

it('silences initial load, shares baselines across views, batches edits, and cleans up', async () => {
  const { contents } = createContents({});
  const observer = new ProjectNotifications(contents, new CommandRegistry());
  const send = async (name: string, universeId = 'default') => {
    const fixture = createContents({ 'astra.yaml': fileModel(analysis(name)) });
    try {
      const { bundle } = await resolveProject(fixture.contents);
      bundle.document.universe.universeId = universeId;
      const data = assembleLoadedProject(bundle, {});
      projectDataUpdated.emit({
        service: contents,
        contents,
        entrypoint: 'astra.yaml',
        data
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      fixture.contents.dispose();
    }
  };
  jest.useFakeTimers();
  try {
    await send('Initial');
    await jest.advanceTimersByTimeAsync(3100);
    expect(Notification.emit).not.toHaveBeenCalled();
    await send('Initial'); // Another view of the same project.
    await send('New name');
    await send('Final name');
    await jest.advanceTimersByTimeAsync(3100);
    expect(Notification.emit).toHaveBeenCalledTimes(1);
    expect(Notification.emit).toHaveBeenCalledWith(
      '1 project change · Final name',
      'default',
      expect.objectContaining({ autoClose: 5000 })
    );
    await send('Other universe', 'alternate');
    await jest.advanceTimersByTimeAsync(3100);
    expect(Notification.update).not.toHaveBeenCalled();
    projectDataDisposed.emit(contents);
    await send('Reopened after offline changes');
    await jest.advanceTimersByTimeAsync(3100);
    expect(Notification.update).not.toHaveBeenCalled();
    await send('Another edit');
    observer.dispose();
    await jest.advanceTimersByTimeAsync(3100);
    expect(Notification.update).not.toHaveBeenCalled();
  } finally {
    observer.dispose();
    contents.dispose();
    jest.useRealTimers();
  }
});
