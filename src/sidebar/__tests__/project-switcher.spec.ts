import { StateDB } from '@jupyterlab/statedb';
import { assembleLoadedProject, resolveProject } from '../../project-data';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import {
  ProjectSwitcher,
  projectFolderName,
  projectLabel,
  RECENT_PROJECT_LIMIT,
  RECENT_PROJECTS_KEY,
  RecentProjects,
  rememberProject,
  siblingFolder
} from '../project-switcher';
import { PROJECT_SPEC } from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

const project = (path: string) => ({
  path,
  entrypoint: path ? `${path}/astra.yaml` : 'astra.yaml'
});

async function loadProject() {
  const { contents } = createContents({
    'project/astra.yaml': fileModel(PROJECT_SPEC)
  });
  try {
    const { bundle } = await resolveProject(contents, 'project/astra.yaml');
    return assembleLoadedProject(bundle, {});
  } finally {
    contents.dispose();
  }
}

describe('recent projects', () => {
  it('puts the latest visit first, once, and keeps a bounded list', () => {
    const list = ['a', 'b', 'c'].map(project);
    expect(rememberProject(list, project('b')).map(item => item.path)).toEqual([
      'b',
      'a',
      'c'
    ]);
    const many = Array.from({ length: RECENT_PROJECT_LIMIT }, (_, i) =>
      project(`p${i}`)
    );
    const next = rememberProject(many, project('new'));
    expect(next).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(next[0].path).toBe('new');
  });

  it('names projects and the folder of their siblings', () => {
    expect(projectFolderName(project('work/hubble'))).toBe('hubble');
    expect(projectFolderName(project(''))).toBe('/');
    expect(siblingFolder(project('work/hubble'))).toBe('work');
    expect(siblingFolder(project('hubble'))).toBe('');
    expect(siblingFolder(project(''))).toBe('');
  });

  it('are remembered across reloads in the state database', async () => {
    const state = new StateDB();
    const first = new RecentProjects(state);
    await first.record(project('a'));
    await first.record(project('b'));
    const second = new RecentProjects(state);
    await second.ready;
    expect(second.projects.map(item => item.path)).toEqual(['b', 'a']);
    await state.save(RECENT_PROJECTS_KEY, [{ path: 1 }, project('c')]);
    const third = new RecentProjects(state);
    await third.ready;
    expect(third.projects.map(item => item.path)).toEqual(['c']);
    const memoryOnly = new RecentProjects(null);
    await memoryOnly.record(project('d'));
    expect(memoryOnly.projects.map(item => item.path)).toEqual(['d']);
  });
});

describe('projectLabel', () => {
  it('uses the spec name, then the folder, then the root', async () => {
    const data = await loadProject();
    const current = project('project');
    expect(projectLabel(current, data)).toBe('Sidebar project');
    expect(projectLabel(current, undefined)).toBe('project');
    expect(projectLabel(project(''), undefined)).toBe('/');
  });
});

describe('the project switcher menu', () => {
  it('lists recent and neighbouring projects, not the current one, then the extras', () => {
    const go = jest.fn();
    const create = jest.fn();
    const switcher = new ProjectSwitcher(go);
    const { menu } = switcher;
    const labels = () =>
      menu.items.map(item => (item.type === 'separator' ? '—' : item.label));
    const run = (index: number) => {
      const item = menu.items[index];
      void menu.commands.execute(item.command, item.args);
    };
    try {
      switcher.fill({
        current: project('work/hubble'),
        recent: [project('work/hubble'), project('other/bao')],
        siblings: ['work/hubble', 'work/cmb', 'other/bao'],
        extras: [{ label: 'New Lightcone project', execute: create }]
      });
      expect(labels()).toEqual([
        'bao',
        '—',
        'cmb',
        '—',
        'New Lightcone project'
      ]);
      expect(menu.items[0].caption).toBe('other/bao');
      run(2);
      expect(go).toHaveBeenCalledWith('work/cmb');
      run(4);
      expect(create).toHaveBeenCalled();

      // Each opening lists the projects of that moment, in the same menu.
      switcher.fill({
        current: project('work/cmb'),
        recent: [],
        siblings: ['work/cmb'],
        extras: []
      });
      expect(labels()).toEqual([]);
      switcher.fill({
        current: project(''),
        recent: [project('a')],
        siblings: [],
        extras: []
      });
      expect(labels()).toEqual(['a']);
      run(0);
      expect(go).toHaveBeenLastCalledWith('a');
    } finally {
      switcher.dispose();
    }
    expect(switcher.isDisposed).toBe(true);
    expect(menu.isDisposed).toBe(true);
  });
});
