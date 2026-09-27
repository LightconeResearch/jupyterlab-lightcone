import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { ServerConnection } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import { ProjectSetup } from '../project-setup';
import {
  inspectProjectFolder,
  initializeProjectFolder,
  type IProjectFolder
} from '../api';

jest.mock('../api', () => ({
  inspectProjectFolder: jest.fn(),
  initializeProjectFolder: jest.fn()
}));
const inspect = jest.mocked(inspectProjectFolder);
const initialize = jest.mocked(initializeProjectFolder);

beforeEach(() => jest.resetAllMocks());

/** Settle `step` and every promise chained on it, then React's updates. */
async function settle(step: () => void = () => undefined): Promise<void> {
  await act(async () => {
    step();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

interface IMounted {
  submit: () => Promise<void>;
  close: () => void;
  node: HTMLElement;
  /** The submit button's label. */
  action: () => string | null;
  /** What the status line announces. */
  status: () => string | null;
}

async function mount(
  options: Partial<ConstructorParameters<typeof ProjectSetup>[0]> & {
    open: jest.Mock;
  }
): Promise<IMounted> {
  const widget = new ProjectSetup({
    path: 'project',
    mode: 'create',
    settings: ServerConnection.makeSettings(),
    browse: jest.fn(),
    findProject: jest.fn().mockResolvedValue(undefined),
    ...options
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
    node,
    action: () => node.querySelector('button[type="submit"]')!.textContent,
    status: () => node.querySelector('[role="status"]')!.textContent
  };
}

it('creates the project in one action, without a confirmation step', async () => {
  const folder = { path: 'new', directory: '/server/new', hasSpec: false };
  const created = { ...folder, hasSpec: true };
  inspect.mockResolvedValue(folder);
  initialize.mockResolvedValue(created);
  const open = jest.fn().mockResolvedValue(undefined);
  const form = await mount({ path: 'new', open });
  expect(form.node.querySelector('button[type="submit"]')!.textContent).toBe(
    'Create project'
  );
  await form.submit();
  expect(inspect).toHaveBeenCalledWith(expect.anything(), 'new');
  expect(initialize).toHaveBeenCalledWith(expect.anything(), 'new');
  expect(open).toHaveBeenCalledWith(created);
  form.close();
});

it('opens an existing project directly instead of setting it up again', async () => {
  const project = {
    path: 'existing',
    directory: '/server/existing',
    hasSpec: true
  };
  inspect.mockResolvedValue(project);
  const open = jest.fn().mockResolvedValue(undefined);
  const form = await mount({ path: 'existing', open });
  await form.submit();
  expect(initialize).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(project);
  form.close();
});

it('finishes setup in one action and can retry after a failure', async () => {
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
  const form = await mount({ path: 'partial', mode: 'finish', open });
  expect(form.node.querySelector('button[type="submit"]')!.textContent).toBe(
    'Finish setup'
  );
  await form.submit();
  expect(form.node.textContent).toContain('Dependency setup failed');
  expect(open).not.toHaveBeenCalled();
  await form.submit();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith(project);
  expect(form.node.textContent).not.toContain('Dependency setup failed');
  form.close();
});

it('writes nothing when the folder cannot be inspected', async () => {
  inspect.mockRejectedValue(
    new Error('Choose a folder inside this Jupyter server')
  );
  const open = jest.fn();
  const form = await mount({ path: '../outside', open });
  await form.submit();
  expect(initialize).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(form.node.textContent).toContain(
    'Choose a folder inside this Jupyter server'
  );
  form.close();
});

it('refuses a folder inside another project before writing anything', async () => {
  inspect.mockResolvedValue({
    path: 'analysis/data',
    directory: '/server/analysis/data',
    hasSpec: false
  });
  const findProject = jest
    .fn()
    .mockResolvedValue({ path: 'analysis', entrypoint: 'analysis/astra.yaml' });
  const open = jest.fn();
  const form = await mount({ path: 'analysis/data', findProject, open });
  await form.submit();
  expect(findProject).toHaveBeenCalledWith('analysis/data');
  expect(initialize).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(form.node.querySelector('[role="alert"]')?.textContent).toBe(
    'This folder is inside the Lightcone project in analysis, and a project cannot be set up inside another one. Choose a folder outside it, or open that project instead.'
  );
  expect(form.action()).toBe('Create project');
  form.close();
});

it('does not look for an enclosing project when the folder already holds one', async () => {
  const project = { path: 'partial', directory: '/p', hasSpec: true };
  inspect.mockResolvedValue(project);
  initialize.mockResolvedValue(project);
  const findProject = jest.fn();
  const open = jest.fn().mockResolvedValue(undefined);
  const form = await mount({ mode: 'finish', findProject, open });
  await form.submit();
  expect(findProject).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(project);
  form.close();
});

it('shows a spinner and announces each busy phase without setup details', async () => {
  const inspection = new PromiseDelegate<IProjectFolder>();
  const setup = new PromiseDelegate<IProjectFolder>();
  const opening = new PromiseDelegate<void>();
  inspect.mockReturnValue(inspection.promise);
  initialize.mockReturnValue(setup.promise);
  const open = jest.fn().mockReturnValue(opening.promise);
  const form = await mount({ path: 'new', open });
  const input = form.node.querySelector('input')!;
  const spinner = () =>
    form.node.querySelector('.jp-jupyterlab-lightcone-ProjectSetup-spinner');
  expect(form.status()).toBe('');
  expect(spinner()).toBeNull();
  // Each phase holds until its promise is released below.
  await settle(() =>
    form.node
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(form.action()).toBe('Checking the folder…');
  expect(form.status()).toBe('Checking the folder…');
  expect(input.disabled).toBe(true);
  expect(spinner()).not.toBeNull();
  await settle(() =>
    inspection.resolve({
      path: 'new',
      directory: '/server/new',
      hasSpec: false
    })
  );
  expect(form.action()).toBe('Setting up project…');
  expect(form.status()).toBe('Setting up project…');
  expect(spinner()).not.toBeNull();
  expect(form.node.textContent).not.toContain('/server/new');
  expect(form.node.textContent).not.toContain('Python environment');
  await settle(() =>
    setup.resolve({ path: 'new', directory: '/server/new', hasSpec: true })
  );
  expect(form.action()).toBe('Opening project…');
  expect(form.status()).toBe('Opening the project…');
  expect(spinner()).not.toBeNull();
  await settle(() => opening.resolve());
  expect(form.action()).toBe('Create project');
  expect(form.status()).toBe('');
  expect(input.disabled).toBe(false);
  expect(spinner()).toBeNull();
  form.close();
});

it('stays busy while the folder dialog is open, then takes the chosen folder', async () => {
  const choice = new PromiseDelegate<string | undefined>();
  const browse = jest.fn().mockReturnValue(choice.promise);
  const form = await mount({ browse, open: jest.fn() });
  const input = form.node.querySelector('input')!;
  const browseButton = form.node.querySelector<HTMLButtonElement>(
    'button[type="button"]'
  )!;
  await settle(() => browseButton.click());
  expect(form.status()).toBe('Choosing a folder…');
  expect(input.disabled).toBe(true);
  expect(browseButton.disabled).toBe(true);
  expect(
    form.node.querySelector<HTMLButtonElement>('button[type="submit"]')!
      .disabled
  ).toBe(true);
  await settle(() => browseButton.click());
  expect(browse).toHaveBeenCalledTimes(1);
  await settle(() => choice.resolve('chosen/folder'));
  expect(form.status()).toBe('');
  expect(input.disabled).toBe(false);
  expect(input.value).toBe('chosen/folder');
  form.close();
});
