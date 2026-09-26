import type { ILabShell } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import { LauncherModel } from '@jupyterlab/launcher';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Contents } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import {
  FakeCurrentProject,
  FakeThemeManager,
  until
} from '../../home/__tests__/home-fixtures';
import { HomeWidget } from '../../home/home-widget';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { TAB_PROJECT_DATASET_KEY } from '../../workbench-ids';
import {
  collidingTabs,
  projectTag,
  shownLabel,
  statedProject,
  TabProjectLabels
} from '../index';

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
jest.mock('../../versions/versions-api', () => ({
  listResultsCommits: jest.fn().mockResolvedValue([])
}));

/** A widget stating the view it shows, as record tabs and inventories do. */
function view(entrypoint: string): Widget {
  return Object.assign(new Widget(), {
    lightconeView: true as const,
    entrypoint
  });
}

/** A Home tab launching into `cwd`; it resolves its project asynchronously. */
function homeTab(
  contents: Contents.IManager,
  cwd: string
): MainAreaWidget<HomeWidget> {
  const content = new HomeWidget({
    model: new LauncherModel(),
    cwd,
    commands: new CommandRegistry(),
    contents,
    documents: { openOrReveal: jest.fn() },
    rendermime: new RenderMimeRegistry(),
    themes: new FakeThemeManager(),
    current: new FakeCurrentProject(),
    callback: jest.fn(),
    onOpenTools: jest.fn()
  });
  return new MainAreaWidget({ content });
}

describe('which tabs name their project', () => {
  it('labels tabs whose label another project also shows', () => {
    const a = { label: 'astra.yaml', project: 'work/hubble' };
    const b = { label: 'astra.yaml', project: 'work/bao' };
    const c = { label: 'Home', project: 'work/hubble' };
    const d = { label: 'Home', project: 'work/hubble' };
    const e = { label: 'notes.md', project: undefined };
    const f = { label: 'notes.md', project: 'work/bao' };
    expect(collidingTabs([a, b, c, d, e, f])).toEqual(new Set([a, b]));
  });

  it('reads the shown label and the tag', () => {
    expect(
      shownLabel({
        label: 'fit.chat',
        dataset: { 'lightcone-session-title': 'Fit' }
      })
    ).toBe('Fit');
    expect(shownLabel({ label: 'x', dataset: {} })).toBe('x');
    expect(projectTag('work/hubble')).toBe('hubble');
    expect(projectTag('')).toBe('/');
  });

  it('reads the project Lightcone views and Home state about themselves', async () => {
    expect(statedProject(view('work/hubble/astra.yaml'))).toBe('work/hubble');
    expect(statedProject(view('astra.yaml'))).toBe('');
    expect(statedProject(view('archive:astra.yaml'))).toBe('archive:');
    // A record tab states its view through the content of its main-area widget.
    expect(
      statedProject(
        new MainAreaWidget({ content: view('work/bao/astra.yaml') })
      )
    ).toBe('work/bao');
    expect(statedProject(new Widget())).toBeUndefined();
    expect(
      statedProject(new MainAreaWidget({ content: new Widget() }))
    ).toBeUndefined();

    // Home states the project it resolved for its folder, once it has.
    const { contents } = createContents({
      'work/bao/astra.yaml': fileModel('name: bao')
    });
    const home = homeTab(contents, 'work/bao');
    try {
      expect(statedProject(home)).toBeUndefined();
      await home.content.settled();
      expect(statedProject(home)).toBe('work/bao');
    } finally {
      home.dispose();
      contents.dispose();
    }
  });
});

describe('TabProjectLabels', () => {
  it('disambiguates projects that share a folder name without changing document names', async () => {
    const { contents } = createContents({});
    const main = ['north/project', 'south/project', 'other'].map(project => {
      const widget = view(`${project}/astra.yaml`);
      widget.title.label = 'astra.yaml';
      return widget;
    });
    const layoutModified = new Signal<ILabShell, void>({} as ILabShell);
    const shell = {
      widgets: () => main[Symbol.iterator](),
      layoutModified
    } as unknown as ILabShell;
    const labels = new TabProjectLabels(shell, contents, null);
    const tags = () =>
      main.map(widget => widget.title.dataset[TAB_PROJECT_DATASET_KEY]);
    try {
      await until(() => tags().every(Boolean));
      expect(tags()).toEqual(['north/project', 'south/project', 'other']);
      expect(main.map(widget => widget.title.label)).toEqual([
        'astra.yaml',
        'astra.yaml',
        'astra.yaml'
      ]);
      main[1].title.label = 'notes.md';
      await until(() => tags()[0] === 'project');
      expect(tags()).toEqual(['project', undefined, 'other']);
    } finally {
      labels.dispose();
      main.forEach(widget => widget.dispose());
      contents.dispose();
    }
  });

  it('tags colliding tabs and clears the tag once the collision ends', async () => {
    const { contents } = createContents({
      'hubble/astra.yaml': fileModel('name: hubble'),
      'bao/astra.yaml': fileModel('name: bao')
    });
    const paths = new Map<Widget, string>();
    const document = (path: string) => {
      const widget = new Widget();
      widget.title.label = 'astra.yaml';
      paths.set(widget, path);
      return widget;
    };
    const hubbleHome = homeTab(contents, 'hubble');
    const baoHome = homeTab(contents, 'bao');
    const hubbleSpec = document('hubble/astra.yaml');
    const baoSpec = document('bao/astra.yaml');
    const main = [hubbleHome, baoHome, hubbleSpec, baoSpec];
    const layoutModified = new Signal<ILabShell, void>({} as ILabShell);
    const shell = {
      widgets: () => main[Symbol.iterator](),
      layoutModified
    } as unknown as ILabShell;
    const documents = {
      contextForWidget: (widget: Widget) =>
        paths.has(widget) ? { path: paths.get(widget) } : undefined
    } as unknown as IDocumentManager;
    const labels = new TabProjectLabels(shell, contents, documents);
    const tag = (widget: Widget) =>
      widget.title.dataset[TAB_PROJECT_DATASET_KEY];
    try {
      // Both Homes read "Home" once their projects resolve, and collide.
      await until(() => main.every(widget => tag(widget) !== undefined));
      expect(main.map(tag)).toEqual(['hubble', 'bao', 'hubble', 'bao']);
      baoHome.title.label = 'Launcher';
      await until(() => tag(hubbleHome) === undefined);
      expect(tag(baoHome)).toBeUndefined();
      expect(tag(hubbleSpec)).toBe('hubble');
    } finally {
      labels.dispose();
      main.forEach(widget => widget.dispose());
      contents.dispose();
    }
  });
});
