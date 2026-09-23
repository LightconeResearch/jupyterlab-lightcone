import { StateDB } from '@jupyterlab/statedb';
import {
  buildProjectSwitcher,
  projectFolderName,
  RECENT_PROJECT_LIMIT,
  RECENT_PROJECTS_KEY,
  RecentProjects,
  rememberProject,
  siblingFolder
} from '../project-switcher';

const project = (path: string) => ({
  path,
  entrypoint: path ? `${path}/astra.yaml` : 'astra.yaml'
});

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

describe('the project switcher menu', () => {
  it('lists recent and neighbouring projects, not the current one, then the extras', () => {
    const go = jest.fn();
    const create = jest.fn();
    const menu = buildProjectSwitcher({
      current: project('work/hubble'),
      recent: [project('work/hubble'), project('other/bao')],
      siblings: ['work/hubble', 'work/cmb', 'other/bao'],
      go,
      extras: [{ label: 'New Lightcone project', execute: create }]
    });
    const labels = menu.items.map(item =>
      item.type === 'separator' ? '—' : item.label
    );
    expect(labels).toEqual([
      'Recent projects',
      'bao',
      '—',
      'Projects in this folder',
      'cmb',
      '—',
      'New Lightcone project'
    ]);
    expect(menu.items[0].isEnabled).toBe(false);
    void menu.commands.execute(menu.items[4].command);
    expect(go).toHaveBeenCalledWith('work/cmb');
    void menu.commands.execute(menu.items[6].command);
    expect(create).toHaveBeenCalled();
    menu.dispose();
  });
});
