import { MainAreaWidget } from '@jupyterlab/apputils';
import type { ILabShell } from '@jupyterlab/application';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  collidingTabs,
  projectTag,
  shownLabel,
  statedProject,
  TabProjectLabels,
  TAB_PROJECT_DATASET_KEY
} from '../index';

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

  it('reads the shown label, the tag and what Lightcone views state', () => {
    expect(
      shownLabel({
        label: 'fit.chat',
        dataset: { 'lightcone-session-title': 'Fit' }
      })
    ).toBe('Fit');
    expect(shownLabel({ label: 'x', dataset: {} })).toBe('x');
    expect(projectTag('work/hubble')).toBe('hubble');
    expect(projectTag('')).toBe('/');
    expect(
      statedProject({ reference: { entrypoint: 'work/hubble/astra.yaml' } })
    ).toBe('work/hubble');
    expect(statedProject({ entrypoint: 'astra.yaml' })).toBe('');
    expect(statedProject({ project: { path: 'work/bao' } })).toBe('work/bao');
    expect(statedProject({ entrypoint: 'notes.md' })).toBeUndefined();
    expect(statedProject(null)).toBeUndefined();
  });
});

describe('TabProjectLabels', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it('tags colliding tabs and clears the tag once the collision ends', async () => {
    const { contents } = createContents({
      'hubble/astra.yaml': fileModel('name: hubble'),
      'bao/astra.yaml': fileModel('name: bao')
    });
    const home = (path: string) => {
      const content = new Widget();
      Object.assign(content, {
        project: { path, entrypoint: `${path}/astra.yaml` }
      });
      const widget = new MainAreaWidget({ content });
      widget.title.label = 'Home';
      return widget;
    };
    const document = (path: string) => {
      const widget = new Widget();
      widget.title.label = 'astra.yaml';
      paths.set(widget, path);
      return widget;
    };
    const paths = new Map<Widget, string>();
    const hubbleHome = home('hubble');
    const baoHome = home('bao');
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
      for (let i = 0; i < 10 && tag(baoSpec) === undefined; i++) await flush();
      expect([hubbleHome, baoHome, hubbleSpec, baoSpec].map(tag)).toEqual([
        'hubble',
        'bao',
        'hubble',
        'bao'
      ]);
      baoHome.title.label = 'Launcher';
      for (let i = 0; i < 10 && tag(hubbleHome) !== undefined; i++)
        await flush();
      expect(tag(hubbleHome)).toBeUndefined();
      expect(tag(baoHome)).toBeUndefined();
      expect(tag(hubbleSpec)).toBe('hubble');
    } finally {
      labels.dispose();
      contents.dispose();
    }
  });
});
