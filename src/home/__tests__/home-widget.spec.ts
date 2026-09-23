import type { Contents } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import { analysis, fileModel } from '../../__tests__/project-fixtures';
import { flush, homeHost, setDocumentHidden, until } from './home-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../api', () => ({
  ...jest.requireActual('../../api'),
  collectPaperMetadata: jest.fn().mockResolvedValue({}),
  fetchPaper: jest.fn()
}));
jest.mock('../../materialization-status', () => ({
  useMaterializationStatus: () => ({}),
  outputMaterializationStatus: () => undefined
}));
jest.mock('../../runs/runs-api', () => ({
  listRuns: jest.fn().mockResolvedValue({ runs: [], jobs: [] })
}));

function host() {
  const entries: Record<string, Contents.IModel> = {
    'project/astra.yaml': fileModel(analysis('Union 2.1 cosmology')),
    'project/data/readme.txt': fileModel('hello'),
    'elsewhere/notes.txt': fileModel('notes'),
    'other/notes.txt': fileModel('notes')
  };
  return { entries, ...homeHost({ entries }) };
}

it('shows the stock launcher outside a project and Home inside one', async () => {
  const h = host();
  h.entries['project/myst.yml'] = fileModel('site: {}');
  try {
    await until(() => h.widget.project === null);
    expect(h.widget.mode).toBe('stock');
    expect(h.widget.title.label).toBe('Launcher');
    expect(h.bodies()).toEqual({
      launcher: true,
      view: false,
      stockBar: false
    });

    h.widget.cwd = 'project/data';
    await until(() => h.widget.project?.entrypoint === 'project/astra.yaml');
    expect(h.widget.mode).toBe('home');
    expect(h.widget.title.label).toBe('Home');
    expect(h.widget.title.caption).toBe('Lightcone Lab · project');
    expect(h.bodies()).toEqual({
      launcher: false,
      view: true,
      stockBar: false
    });

    // The page renders from the project's own data, with no results yet.
    await until(() => h.text().includes('Union 2.1 cosmology'));
    await until(() => h.text().includes('Open report'));
    const text = h.text();
    expect(text).toContain('Lightcone Lab');
    expect(text).toContain('No results yet');
    expect(text).toContain('0 decisions');
    // No sessions service: no desk, no composer.
    expect(text).not.toContain('New session');

    const tools = h.query<HTMLButtonElement>(
      '.jp-jupyterlab-lightcone-Home-tools'
    );
    tools!.click();
    expect(h.onOpenTools).toHaveBeenCalledWith(tools);
  } finally {
    h.dispose();
  }
});

it('switches to the full launcher per tab and forgets that on leaving the project', async () => {
  const h = host();
  try {
    h.widget.cwd = 'project';
    await until(() => h.widget.mode === 'home');
    h.widget.showLauncher();
    expect(h.widget.mode).toBe('stock');
    expect(h.widget.title.label).toBe('Launcher');
    expect(h.bodies()).toEqual({ launcher: true, view: false, stockBar: true });
    expect(h.text()).toContain('Showing the full launcher for project.');
    h.widget.showHome();
    expect(h.widget.mode).toBe('home');

    h.widget.showLauncher();
    h.widget.cwd = 'elsewhere';
    await until(() => h.widget.project === null);
    expect(h.bodies()).toEqual({
      launcher: true,
      view: false,
      stockBar: false
    });
    h.widget.cwd = 'project/data';
    await until(() => h.widget.mode === 'home');
  } finally {
    h.dispose();
  }
});

it('ignores a project lookup that settles after the tab moved on', async () => {
  const h = host();
  try {
    h.widget.cwd = 'project';
    await until(() => h.widget.mode === 'home');
    const pending = new PromiseDelegate<Contents.IModel>();
    // The current project changed: the tab looks its folder up again, slowly.
    h.get.mockImplementationOnce(() => pending.promise);
    h.changed.emit();
    await Promise.resolve();
    h.widget.cwd = 'elsewhere';
    await until(() => h.widget.project === null);
    // The outdated answer names the project the tab has left.
    pending.resolve(
      fileModel(analysis('Union 2.1 cosmology'), { path: 'project/astra.yaml' })
    );
    await flush();
    await flush();
    expect(h.widget.project).toBeNull();
    expect(h.widget.mode).toBe('stock');
    expect(h.widget.title.label).toBe('Launcher');
  } finally {
    h.dispose();
  }
});

it('names the folder the stock launcher opens into as the file browser moves', async () => {
  const h = host();
  try {
    await until(() => h.widget.project === null);
    expect(h.widget.title.caption).toBe('elsewhere');
    // Another folder outside any project: the lookup finds no project again.
    h.widget.cwd = 'other';
    await flush();
    await flush();
    expect(h.widget.project).toBeNull();
    expect(h.widget.title.caption).toBe('other');
    h.widget.cwd = '';
    expect(h.widget.title.caption).toBe('/');

    // Inside a project the caption names the project, from any subfolder.
    h.widget.cwd = 'project';
    await until(() => h.widget.mode === 'home');
    h.widget.cwd = 'project/data';
    expect(h.widget.title.caption).toBe('Lightcone Lab · project');
  } finally {
    h.dispose();
  }
});

it('offers the report once a MyST configuration appears outside Contents', async () => {
  const h = host();
  try {
    h.widget.cwd = 'project';
    await until(() => h.text().includes('Union 2.1 cosmology'));
    await until(() =>
      h.get.mock.calls.some(
        ([path, options]) => path === 'project' && options?.content === true
      )
    );
    await flush();
    expect(h.text()).not.toContain('Open report');
    // The check lists the project folder: asking for the missing files would
    // log a 404 warning on the server at every poll.
    const asked = h.get.mock.calls.map(([path]) => path);
    expect(asked).not.toContain('project/myst.yml');
    expect(asked).not.toContain('project/myst.yaml');

    // An agent or `myst init` writes the file on the server while the user
    // looks at another tab; no Contents event announces it.
    h.widget.hide();
    h.entries['project/myst.yml'] = fileModel('site: {}');
    h.widget.show();
    await until(() => h.text().includes('Open report'));
  } finally {
    h.dispose();
  }
});

it('stops looking for the report while the browser tab is hidden', async () => {
  const h = host();
  const listings = () =>
    h.get.mock.calls.filter(
      ([path, options]) => path === 'project' && options?.content === true
    ).length;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const reshow = () => {
    h.widget.hide();
    h.widget.show();
  };
  try {
    h.widget.cwd = 'project';
    await until(() => listings() > 0);
    setDocumentHidden(true);
    // Lumino's polls linger for one tick after the browser tab hides.
    reshow();
    await wait(50);
    const calls = listings();
    reshow();
    await wait(50);
    expect(listings()).toBe(calls);

    setDocumentHidden(false);
    reshow();
    await until(() => listings() > calls);
  } finally {
    setDocumentHidden(false);
    h.dispose();
  }
});
