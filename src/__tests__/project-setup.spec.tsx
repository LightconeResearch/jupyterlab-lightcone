import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { ServerConnection } from '@jupyterlab/services';
import { ProjectSetup } from '../project-setup';
import { inspectProjectFolder, initializeProjectFolder } from '../api';

jest.mock('../api', () => ({
  inspectProjectFolder: jest.fn(),
  initializeProjectFolder: jest.fn()
}));
const inspect = jest.mocked(inspectProjectFolder);
const initialize = jest.mocked(initializeProjectFolder);

beforeEach(() => jest.resetAllMocks());

it('can resume initialization after reopening with an astra.yaml already present', async () => {
  const project = {
    path: 'partial',
    directory: '/server/partial',
    hasSpec: true
  };
  inspect.mockResolvedValue(project);
  initialize
    .mockRejectedValueOnce(new Error('Dependency setup failed'))
    .mockResolvedValue(project);
  const open = jest.fn().mockResolvedValue(undefined);
  const mount = async () => {
    const widget = new ProjectSetup({
      path: 'partial',
      mode: 'finish',
      settings: ServerConnection.makeSettings(),
      browse: jest.fn(),
      open
    });
    const node = document.createElement('div');
    const root = createRoot(node);
    await act(async () => root.render(widget.render()));
    return {
      submit: async () => {
        await act(async () => {
          node
            .querySelector('form')!
            .dispatchEvent(
              new Event('submit', { bubbles: true, cancelable: true })
            );
        });
      },
      close: () => {
        act(() => root.unmount());
        widget.dispose();
      },
      node
    };
  };
  const first = await mount();
  await first.submit();
  expect(initialize).not.toHaveBeenCalled();
  await first.submit();
  expect(first.node.textContent).toContain('Dependency setup failed');
  expect(open).not.toHaveBeenCalled();
  first.close();
  const reopened = await mount();
  await reopened.submit();
  expect(reopened.node.textContent).toContain('/server/partial');
  await reopened.submit();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith(project);
  reopened.close();
});

it('offers a separate finish-setup action for existing projects without writing on inspection', async () => {
  const project = {
    path: 'existing',
    directory: '/server/existing',
    hasSpec: true
  };
  inspect.mockResolvedValue(project);
  const open = jest.fn();
  const widget = new ProjectSetup({
    path: 'existing',
    mode: 'create',
    settings: ServerConnection.makeSettings(),
    browse: jest.fn(),
    open
  });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(widget.render()));
  await act(async () => {
    node
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(node.textContent).toContain('Open project');
  expect(node.textContent).toContain('Finish setup…');
  expect(initialize).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  act(() => root.unmount());
  widget.dispose();
});
