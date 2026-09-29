import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ContentsManager, ServerConnection } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { reportCurrentProject } from '../api';
import {
  CurrentProject,
  currentProjectPlugin,
  type ICurrentProject
} from '../current-project';
import { ProjectStatus } from '../project-status';
import { nullTranslator } from '@jupyterlab/translation';
import { fileModel } from './project-fixtures';
import { withLightconeServer } from './server-fixtures';

jest.mock('../pdf-runtime', () => ({}));
jest.mock('../api', () => ({
  reportCurrentProject: jest.fn(() => Promise.resolve())
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function browser(path: string) {
  return { model: { path, refreshed: new Signal<object, void>({}) } };
}

function host(path = 'project') {
  const contents = new ContentsManager();
  const specs = new Set(['project/astra.yaml', 'other/astra.yaml']);
  const get = jest.spyOn(contents, 'get').mockImplementation(async path => {
    if (!specs.has(path))
      throw new ServerConnection.ResponseError(
        new Response('', { status: 404 })
      );
    return fileModel('', { path });
  });
  const first = browser(path);
  const tracker = {
    currentWidget: first as ReturnType<typeof browser> | null,
    currentChanged: new Signal<object, void>({})
  };
  const browsers = tracker as unknown as IFileBrowserFactory['tracker'];
  const navigate = async (to: string) => {
    tracker.currentWidget!.model.path = to;
    tracker.currentWidget!.model.refreshed.emit();
    await flush();
  };
  return { contents, get, specs, tracker, browsers, navigate };
}

describe('CurrentProject', () => {
  it('follows the file browser folder and changes only between projects', async () => {
    const h = host();
    const current = new CurrentProject(h.contents, h.browsers);
    const changes: (string | null | undefined)[] = [];
    current.changed.connect(() =>
      changes.push(current.project && current.project.entrypoint)
    );
    try {
      expect(current.project).toBeUndefined();
      await flush();
      expect(current.project).toEqual({
        path: 'project',
        entrypoint: 'project/astra.yaml'
      });
      await h.navigate('project/data/raw');
      await h.navigate('other');
      await h.navigate('elsewhere');
      expect(current.project).toBeNull();
      await h.navigate('');
      // Moving within a project, or between folders outside one, is quiet.
      expect(changes).toEqual(['project/astra.yaml', 'other/astra.yaml', null]);
    } finally {
      current.dispose();
      h.contents.dispose();
    }
  });

  it('follows whichever file browser is current', async () => {
    const h = host();
    const current = new CurrentProject(h.contents, h.browsers);
    try {
      await flush();
      const first = h.tracker.currentWidget!;
      h.tracker.currentWidget = browser('other');
      h.tracker.currentChanged.emit();
      await flush();
      expect(current.project?.entrypoint).toBe('other/astra.yaml');
      // The previous browser no longer decides.
      first.model.path = 'elsewhere';
      first.model.refreshed.emit();
      await flush();
      expect(current.project?.entrypoint).toBe('other/astra.yaml');
    } finally {
      current.dispose();
      h.contents.dispose();
    }
  });

  it('treats a failed lookup as unknown rather than keeping a stale project', async () => {
    const h = host();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const current = new CurrentProject(h.contents, h.browsers);
    try {
      await flush();
      h.get.mockRejectedValueOnce(new Error('offline'));
      await h.navigate('project/data');
      expect(current.project).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'Could not determine the current Lightcone project.',
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
      current.dispose();
      h.contents.dispose();
    }
  });
});

describe('currentProjectPlugin', () => {
  const report = reportCurrentProject as jest.MockedFunction<
    typeof reportCurrentProject
  >;

  beforeEach(() => report.mockClear());

  it('tracks the project but reports nothing without Lightcone’s server', async () => {
    const h = host();
    const shell = new Widget();
    const app = {
      shell,
      serviceManager: {
        contents: h.contents,
        serverSettings: ServerConnection.makeSettings()
      }
    } as unknown as JupyterFrontEnd;
    const current = currentProjectPlugin.activate(app, {
      tracker: h.tracker
    }) as ICurrentProject;
    try {
      await flush();
      expect(current.project?.entrypoint).toBe('project/astra.yaml');
      window.dispatchEvent(new Event('focus'));
      await h.navigate('other');
      expect(current.project?.entrypoint).toBe('other/astra.yaml');
      expect(report).not.toHaveBeenCalled();
    } finally {
      shell.dispose();
      h.contents.dispose();
    }
  });
});

describe('currentProjectPlugin with Lightcone’s server', () => {
  const report = reportCurrentProject as jest.MockedFunction<
    typeof reportCurrentProject
  >;

  withLightconeServer();
  beforeEach(() => report.mockClear());

  it('reports each change, and again when its window regains focus', async () => {
    const h = host();
    const shell = new Widget();
    const serverSettings = ServerConnection.makeSettings();
    const app = {
      shell,
      serviceManager: { contents: h.contents, serverSettings }
    } as unknown as JupyterFrontEnd;
    const current = currentProjectPlugin.activate(app, {
      tracker: h.tracker
    }) as ICurrentProject;
    try {
      // Nothing is reported before the first lookup settles.
      window.dispatchEvent(new Event('focus'));
      expect(report).not.toHaveBeenCalled();
      await flush();
      expect(report).toHaveBeenLastCalledWith(
        serverSettings,
        'project/astra.yaml'
      );
      await h.navigate('elsewhere');
      expect(report).toHaveBeenLastCalledWith(serverSettings, null);
      await h.navigate('other');
      report.mockClear();
      window.dispatchEvent(new Event('focus'));
      await flush();
      expect(report).toHaveBeenCalledWith(serverSettings, 'other/astra.yaml');
      expect(current.project?.entrypoint).toBe('other/astra.yaml');
    } finally {
      shell.dispose();
      h.contents.dispose();
    }
    // Disposing the shell stops focus reports.
    report.mockClear();
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(report).not.toHaveBeenCalled();
  });

  it('sends reports one after another, so the last change wins on the server', async () => {
    const h = host();
    const shell = new Widget();
    const app = {
      shell,
      serviceManager: {
        contents: h.contents,
        serverSettings: ServerConnection.makeSettings()
      }
    } as unknown as JupyterFrontEnd;
    currentProjectPlugin.activate(app, { tracker: h.tracker });
    try {
      await flush();
      const slow = new PromiseDelegate<void>();
      report.mockClear();
      report.mockImplementationOnce(() => slow.promise);
      await h.navigate('elsewhere');
      await h.navigate('other');
      // The second report waits for the slow first one instead of racing it.
      expect(report.mock.calls.map(([, entrypoint]) => entrypoint)).toEqual([
        null
      ]);
      slow.resolve();
      await flush();
      expect(report.mock.calls.map(([, entrypoint]) => entrypoint)).toEqual([
        null,
        'other/astra.yaml'
      ]);
    } finally {
      shell.dispose();
      h.contents.dispose();
    }
  });
});

describe('ProjectStatus', () => {
  it('names the current project and opens its inventory', async () => {
    const h = host('project');
    const current = new CurrentProject(h.contents, h.browsers);
    const open = jest.fn();
    const status = new ProjectStatus(
      current,
      open,
      nullTranslator.load('jupyterlab_lightcone')
    );
    try {
      await flush();
      expect(status.node.textContent).toBe('Lightcone · project');
      expect(status.node.title).toContain(
        'Current ASTRA project: project\nNew chats'
      );
      status.node.click();
      status.node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(open.mock.calls).toEqual([
        ['project/astra.yaml'],
        ['project/astra.yaml']
      ]);
      // Outside every project the item is hidden and inert.
      await h.navigate('elsewhere');
      status.node.click();
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      status.dispose();
      current.dispose();
      h.contents.dispose();
    }
  });
});
