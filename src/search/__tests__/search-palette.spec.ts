import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { act } from 'react';
import { bindLabColorScheme } from '../../astra-kind';
import type { ISearchCandidate } from '../search-candidates';
import { SearchPalette } from '../search-palette';

let actEnvironment: unknown;
beforeAll(() => {
  actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
});

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

/** Render the palette for `query` and read its headers and rows in order. */
function render(
  palette: SearchPalette,
  query = ''
): { headers: string[]; rows: string[]; marks: string[] } {
  if (!palette.isAttached) {
    Widget.attach(palette, document.body);
  }
  palette.inputNode.value = query;
  palette.refresh();
  act(() => {
    MessageLoop.sendMessage(palette, Widget.Msg.UpdateRequest);
    MessageLoop.flush();
  });
  const text = (selector: string) =>
    Array.from(palette.contentNode.querySelectorAll(selector)).map(
      node => node.textContent ?? ''
    );
  return {
    headers: text('.lm-CommandPalette-header'),
    rows: text('.lm-CommandPalette-itemLabel'),
    marks: text('.lm-CommandPalette-header mark')
  };
}

/** A theme manager whose theme has the given lightness. */
class FakeThemeManager implements IThemeManager {
  constructor(private readonly light: boolean) {}
  get theme(): string {
    return this.light ? 'JupyterLab Light' : 'JupyterLab Dark';
  }
  themes = ['JupyterLab Light', 'JupyterLab Dark'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => this.light;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

/** Bind the kind marks to a Lab theme of the given lightness. */
function bindTheme(light: boolean): IDisposable {
  return bindLabColorScheme(new FakeThemeManager(light));
}

describe('SearchPalette', () => {
  let palette: SearchPalette;

  beforeEach(() => {
    palette = new SearchPalette({ placeholder: 'Search the project' });
  });

  afterEach(() => {
    act(() => palette.dispose());
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
    expect(palette.items.map(item => item.label)).toEqual([
      'Cosmology fit',
      'Fitting range'
    ]);
    const item = palette.items[0];
    expect(item.caption).toBe('outputs.fit');
    expect(item.dataset).toEqual({ kind: 'output' });
    expect(render(palette)).toMatchObject({
      headers: ['Results', 'Decisions'],
      rows: ['Cosmology fit', 'Fitting range']
    });
  });

  it('lists sections in display order, not alphabetically', () => {
    palette.setCandidates('commands', [
      candidate({
        id: 'command:jupyterlab_lightcone:create-project',
        kind: 'command',
        category: 'Commands',
        label: 'Create project',
        action: { type: 'command', id: 'jupyterlab_lightcone:create-project' }
      })
    ]);
    palette.setCandidates('records', [
      candidate({ label: 'Hubble diagram' }),
      candidate({
        id: 'record:decisions.range',
        kind: 'decision',
        category: 'Decisions',
        label: 'Fitting range',
        rank: 1
      }),
      candidate({
        id: 'record:findings.result',
        kind: 'finding',
        category: 'Findings',
        label: 'Our result',
        rank: 2
      }),
      candidate({
        id: 'paper:10.1/x',
        kind: 'paper',
        category: 'Papers',
        label: 'Hubble 1929',
        rank: 3,
        action: { type: 'paper', entrypoint: 'astra.yaml', doi: '10.1/x' }
      })
    ]);
    palette.setCandidates('sessions', [
      candidate({
        id: 'session:chats/hubble.chat',
        kind: 'session',
        category: 'Sessions',
        label: 'Hubble fit',
        action: { type: 'session', path: 'chats/hubble.chat' }
      })
    ]);
    expect(render(palette).headers).toEqual([
      'Sessions',
      'Results',
      'Decisions',
      'Findings',
      'Papers',
      'Commands'
    ]);
    // Equally good matches follow the same order.
    expect(render(palette, 'hubble').rows).toEqual([
      'Hubble fit',
      'Hubble diagram',
      'Hubble 1929'
    ]);
    // A query naming a section highlights its plain name.
    expect(render(palette, 'decisions')).toMatchObject({
      headers: ['Decisions'],
      marks: ['Decisions']
    });
  });

  it('marks records and papers as the inventory does, and nothing else', () => {
    palette.setCandidates('records', [
      candidate({}),
      candidate({
        id: 'record:decisions.range',
        kind: 'decision',
        category: 'Decisions',
        label: 'Fitting range',
        rank: 1
      }),
      candidate({
        id: 'record:inputs.catalog',
        kind: 'input',
        category: 'Inputs',
        label: 'Catalog',
        rank: 2
      }),
      candidate({
        id: 'record:prior_insights.h0',
        kind: 'prior_insight',
        category: 'Findings',
        label: 'Local H0',
        rank: 3
      }),
      candidate({
        id: 'paper:10.1/x',
        kind: 'paper',
        category: 'Papers',
        label: 'Hubble 1929',
        rank: 4,
        action: { type: 'paper', entrypoint: 'astra.yaml', doi: '10.1/x' }
      })
    ]);
    palette.setCandidates('sessions', [
      candidate({
        id: 'session:chats/hubble.chat',
        kind: 'session',
        category: 'Sessions',
        label: 'Hubble fit',
        action: { type: 'session', path: 'chats/hubble.chat' }
      })
    ]);
    render(palette);
    const rows = Array.from(
      palette.contentNode.querySelectorAll('.lm-CommandPalette-item')
    );
    const kindOf = (row: Element) =>
      row
        .querySelector(
          '.lm-CommandPalette-itemIcon > .lightcone-brand.astra-ui > .astra-kind-glyph'
        )
        ?.getAttribute('data-kind') ?? null;
    expect(rows.map(kindOf)).toEqual([
      null,
      'output',
      'decision',
      'input',
      'prior_insight',
      'paper'
    ]);
    // The glyphs are ASTRA UI's own: symbols, and a drawing for papers.
    expect(
      rows
        .slice(1, 5)
        .map(row => row.querySelector('.astra-kind-glyph')?.textContent)
    ).toEqual(['◆', '◇', '▤', '◈']);
    expect(rows[5].querySelector('.astra-kind-glyph svg')).not.toBeNull();
    // The marks follow the Lab theme through the theme manager they are
    // bound to, so the Lightcone dark kind colours apply.
    let dark: IDisposable | undefined;
    act(() => {
      dark = bindTheme(false);
    });
    try {
      render(palette, 'fit');
      const mark = palette.contentNode.querySelector(
        '.lm-CommandPalette-itemIcon > .lightcone-brand.astra-ui'
      );
      expect(mark?.getAttribute('data-astra-color-scheme')).toBe('dark');
      expect(mark?.getAttribute('data-lightcone-color-scheme')).toBe('dark');
    } finally {
      dark?.dispose();
      act(() => bindTheme(true).dispose());
    }
  });

  it('unmounts React marks when a row changes to a stock icon or the palette closes', () => {
    palette.setCandidates('records', [candidate({})]);
    render(palette);
    const firstIcon = palette.contentNode.querySelector(
      '.lm-CommandPalette-itemIcon'
    );
    expect(firstIcon?.querySelector('.astra-kind-glyph')).not.toBeNull();
    // CommandPalette reuses row elements when the candidate group changes.
    palette.setCandidates('records', [
      candidate({
        kind: 'command',
        category: 'Commands',
        action: { type: 'command', id: 'x' }
      })
    ]);
    render(palette);
    expect(firstIcon?.childElementCount).toBe(0);
    expect(palette.contentNode.querySelector('.astra-kind-glyph')).toBeNull();
    palette.setCandidates('records', [candidate({ kind: 'paper' })]);
    render(palette);
    const lastIcon = palette.contentNode.querySelector(
      '.lm-CommandPalette-itemIcon'
    );
    expect(lastIcon?.querySelector('svg')).not.toBeNull();
    act(() => palette.dispose());
    expect(lastIcon?.childElementCount).toBe(0);
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

  it('hides files until there is a query and disabled commands altogether', () => {
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
    expect(command.isVisible).toBe(false);
    // A query matching only a disabled command reads as no match.
    expect(
      palette.contentNode.querySelector('.lm-CommandPalette-emptyMessage')
    ).toBeNull();
    render(palette, 'pin');
    expect(
      palette.contentNode.querySelector('.lm-CommandPalette-emptyMessage')
        ?.textContent
    ).toBe("Nothing matches 'pin'");
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
