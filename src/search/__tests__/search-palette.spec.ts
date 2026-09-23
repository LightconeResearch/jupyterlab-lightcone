import type { ISearchCandidate } from '../search-candidates';
import { SearchPalette } from '../search-palette';

function candidate(overrides: Partial<ISearchCandidate>): ISearchCandidate {
  return {
    id: 'record:outputs.fit',
    kind: 'output',
    category: 'Results',
    label: 'Cosmology fit',
    caption: 'outputs.fit',
    rank: 0,
    action: { type: 'record', entrypoint: 'astra.yaml', target: 'outputs.fit' },
    ...overrides
  };
}

describe('SearchPalette', () => {
  let palette: SearchPalette;

  beforeEach(() => {
    palette = new SearchPalette({ placeholder: 'Search the project' });
  });

  afterEach(() => {
    palette.dispose();
  });

  it('registers each candidate as a private command under its category', () => {
    palette.setCandidates('records', [
      candidate({}),
      candidate({
        id: 'record:decisions.range',
        kind: 'decision',
        category: 'Decisions',
        label: 'Fitting range',
        caption: 'decisions.range',
        rank: 1
      })
    ]);
    expect(palette.inputNode.placeholder).toBe('Search the project');
    expect(palette.items.map(item => [item.category, item.label])).toEqual([
      ['Results', 'Cosmology fit'],
      ['Decisions', 'Fitting range']
    ]);
    const item = palette.items[0];
    expect(item.caption).toBe('outputs.fit');
    expect(item.dataset).toEqual({ kind: 'output' });
    expect(palette.candidates('records')).toHaveLength(2);
    expect(palette.candidates('files')).toHaveLength(0);
  });

  it('emits the chosen candidate when its command runs', async () => {
    const chosen: ISearchCandidate[] = [];
    palette.selected.connect((_sender, value) => {
      chosen.push(value);
    });
    const session = candidate({
      id: 'session:chats/a.chat',
      kind: 'session',
      category: 'Sessions',
      label: 'A',
      action: { type: 'session', path: 'chats/a.chat' }
    });
    palette.setCandidates('sessions', [session]);
    await palette.commands.execute(palette.items[0].command);
    expect(chosen).toEqual([session]);
  });

  it('hides files until there is a query and follows live enablement', () => {
    let enabled = true;
    palette.setCandidates('files', [
      candidate({
        id: 'file:src/plot.py',
        kind: 'file',
        category: 'Files',
        label: 'plot.py',
        caption: 'src',
        action: { type: 'file', path: 'src/plot.py' }
      })
    ]);
    palette.setCandidates('commands', [
      candidate({
        id: 'command:jupyterlab_lightcone:pin-element',
        kind: 'command',
        category: 'Commands',
        label: 'Pin',
        caption: '',
        action: { type: 'command', id: 'jupyterlab_lightcone:pin-element' },
        isEnabled: () => enabled
      })
    ]);
    const [file, command] = palette.items;
    expect(file.isVisible).toBe(false);
    palette.inputNode.value = ' plot ';
    expect(palette.query).toBe('plot');
    expect(file.isVisible).toBe(true);
    expect(command.isVisible).toBe(true);
    expect(command.isEnabled).toBe(true);
    enabled = false;
    expect(command.isEnabled).toBe(false);
  });

  it('replaces a group without touching the others, collapses duplicate IDs and clears', () => {
    palette.setCandidates('records', [candidate({})]);
    palette.setCandidates('commands', [
      candidate({
        id: 'command:x',
        kind: 'command',
        category: 'Commands',
        label: 'X',
        action: { type: 'command', id: 'x' }
      })
    ]);
    palette.setCandidates('records', [
      candidate({ label: 'Renamed fit' }),
      candidate({ label: 'Duplicate' })
    ]);
    expect(palette.items.map(item => item.label)).toEqual(['X', 'Renamed fit']);
    expect(palette.commands.hasCommand('records:record:outputs.fit')).toBe(
      true
    );
    palette.clear();
    expect(palette.items).toHaveLength(0);
    expect(palette.commands.listCommands()).toEqual([]);
  });
});
