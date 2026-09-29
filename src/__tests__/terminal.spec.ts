import type { ILabShell } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import type { Terminal } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget, type DockLayout } from '@lumino/widgets';
import {
  openTerminal,
  terminalEnded,
  terminalPlacement,
  typedCommand
} from '../terminal';
import { TERMINAL_COMMAND } from '../workbench-ids';

/** A named widget, as the dock holds it. */
function tab(id: string): Widget {
  const widget = new Widget();
  widget.id = id;
  return widget;
}

function tabs(...widgets: Widget[]): DockLayout.ITabAreaConfig {
  return { type: 'tab-area', widgets, currentIndex: widgets.length - 1 };
}

function columns(
  ...children: DockLayout.AreaConfig[]
): DockLayout.ISplitAreaConfig {
  return {
    type: 'split-area',
    orientation: 'horizontal',
    children,
    sizes: children.map(() => 1 / children.length)
  };
}

describe('terminalPlacement', () => {
  const home = tab('home');

  it('splits off a column on the right of a lone tab area', () => {
    expect(terminalPlacement(home, { main: tabs(home, tab('other')) })).toEqual(
      { mode: 'split-right', ref: 'home' }
    );
    expect(terminalPlacement(home, null)).toEqual({
      mode: 'split-right',
      ref: 'home'
    });
  });

  it('joins the column on the right, after the tab it shows', () => {
    const record = tab('record');
    const layout = { main: columns(tabs(home), tabs(tab('pinned'), record)) };
    expect(terminalPlacement(home, layout)).toEqual({
      mode: 'tab-after',
      ref: 'record'
    });
  });

  it('never goes left: the rightmost column splits instead', () => {
    const layout = { main: columns(tabs(tab('left')), tabs(home)) };
    expect(terminalPlacement(home, layout)).toEqual({
      mode: 'split-right',
      ref: 'home'
    });
  });

  it('looks past a stacked column to the next one out', () => {
    const right = tab('right');
    const stacked: DockLayout.ISplitAreaConfig = {
      type: 'split-area',
      orientation: 'vertical',
      children: [tabs(home), tabs(tab('below'))],
      sizes: [0.5, 0.5]
    };
    const layout = { main: columns(stacked, tabs(right)) };
    expect(terminalPlacement(home, layout)).toEqual({
      mode: 'tab-after',
      ref: 'right'
    });
  });
});

/** A terminal session that records what is typed, and the shell's output to emit. */
class FakeSession {
  readonly messageReceived = new Signal<this, Terminal.IMessage>(this);
  readonly connectionStatusChanged = new Signal<
    this,
    Terminal.ITerminalConnection['connectionStatus']
  >(this);
  readonly disposed = new Signal<this, void>(this);
  readonly typed: string[] = [];
  connectionStatus: Terminal.ITerminalConnection['connectionStatus'] =
    'connected';
  isDisposed = false;

  /** The websocket comes up, after which the shell's output arrives. */
  connect(): void {
    this.connectionStatus = 'connected';
    this.connectionStatusChanged.emit('connected');
  }

  /** The shell exits: the connection disposes itself. */
  exit(): void {
    this.isDisposed = true;
    this.disposed.emit();
  }

  send(message: Terminal.IMessage): void {
    this.typed.push(...(message.content ?? []).map(String));
  }

  print(text: string): void {
    this.messageReceived.emit({ type: 'stdout', content: [text] });
  }
}

describe('openTerminal', () => {
  let commands: CommandRegistry;
  let session: FakeSession;
  let terminal: MainAreaWidget;

  beforeEach(() => {
    jest.useFakeTimers();
    session = new FakeSession();
    const content = new Widget();
    Object.assign(content, { session });
    terminal = new MainAreaWidget({ content });
    terminal.id = 'terminal';
    commands = new CommandRegistry();
    commands.addCommand(TERMINAL_COMMAND, {
      execute: jest.fn(() => terminal)
    });
  });

  afterEach(() => {
    terminal.dispose();
    jest.useRealTimers();
  });

  it('types the command once the prompt is drawn, without running it', async () => {
    const opened = openTerminal(commands, {
      cwd: 'project',
      command: 'claude'
    });
    await jest.advanceTimersByTimeAsync(0);
    session.print('Welcome\r\n');
    await jest.advanceTimersByTimeAsync(200);
    session.print('project $ ');
    await jest.advanceTimersByTimeAsync(200);
    // Still drawing: typing now would echo ahead of the prompt.
    expect(session.typed).toEqual([]);
    await jest.advanceTimersByTimeAsync(200);
    await opened;
    expect(session.typed).toEqual(['claude']);
  });

  it('types into a shell that stays silent once its prompt may be shown', async () => {
    const opened = openTerminal(commands, {
      cwd: 'project',
      command: 'lc init'
    });
    await jest.advanceTimersByTimeAsync(900);
    expect(session.typed).toEqual([]);
    await jest.advanceTimersByTimeAsync(200);
    await opened;
    expect(session.typed).toEqual(['lc init']);
  });

  it('runs the command when asked, pressing Enter after it', async () => {
    const opened = openTerminal(commands, {
      cwd: 'project',
      command: 'codex',
      run: true
    });
    await jest.advanceTimersByTimeAsync(1100);
    await opened;
    expect(session.typed).toEqual(['codex\r']);
  });

  it('times the prompt only once the connection is up', async () => {
    session.connectionStatus = 'connecting';
    const opened = openTerminal(commands, {
      cwd: 'project',
      command: 'claude',
      run: true
    });
    // A slow connection: silence meanwhile is no prompt.
    await jest.advanceTimersByTimeAsync(3000);
    expect(session.typed).toEqual([]);
    session.connect();
    await jest.advanceTimersByTimeAsync(0);
    session.print('project $ ');
    await jest.advanceTimersByTimeAsync(400);
    await opened;
    expect(session.typed).toEqual(['claude\r']);
  });

  it('opens a plain terminal in the folder without typing', async () => {
    const execute = jest.spyOn(commands, 'execute');
    await openTerminal(commands, { cwd: 'project' });
    expect(execute).toHaveBeenCalledWith(TERMINAL_COMMAND, { cwd: 'project' });
    await jest.advanceTimersByTimeAsync(2000);
    expect(session.typed).toEqual([]);
  });

  it('moves the terminal beside the tab that was current', async () => {
    const home = tab('home');
    const add = jest.fn();
    const activateById = jest.fn();
    const shell = {
      currentWidget: home,
      add,
      activateById,
      saveLayout: () => ({ mainArea: { dock: { main: tabs(home, terminal) } } })
    } as unknown as ILabShell;
    await openTerminal(commands, { cwd: 'project', shell });
    expect(add).toHaveBeenCalledWith(terminal, 'main', {
      mode: 'split-right',
      ref: 'home'
    });
    expect(activateById).toHaveBeenCalledWith('terminal');
    home.dispose();
  });
});

describe('typedCommand', () => {
  it('types a command as given in a project folder', () => {
    expect(typedCommand('work/project', 'claude')).toBe('claude');
  });

  it('first moves to the server root, which the terminal server may miss', () => {
    for (const root of ['', '.']) {
      expect(typedCommand(root, 'lc init && exit')).toBe(
        'cd "$JUPYTER_SERVER_ROOT" && lc init && exit'
      );
    }
  });
});

describe('terminalEnded', () => {
  function opened(): { widget: Widget; session: FakeSession } {
    return { widget: new Widget(), session: new FakeSession() };
  }

  it('settles when the shell exits', async () => {
    const terminal = opened();
    let ended = false;
    const waiting = terminalEnded({
      widget: terminal.widget,
      session: terminal.session as unknown as Terminal.ITerminalConnection
    }).then(() => (ended = true));
    await Promise.resolve();
    expect(ended).toBe(false);
    terminal.session.exit();
    await waiting;
    expect(ended).toBe(true);
    terminal.widget.dispose();
  });

  it('settles when the tab closes, with or without a connection', async () => {
    const terminal = opened();
    const waiting = terminalEnded({
      widget: terminal.widget,
      session: terminal.session as unknown as Terminal.ITerminalConnection
    });
    terminal.widget.dispose();
    await waiting;
    const bare = new Widget();
    const unconnected = terminalEnded({ widget: bare, session: undefined });
    bare.dispose();
    await unconnected;
  });

  it('settles at once for a terminal that already ended', async () => {
    const terminal = opened();
    terminal.session.exit();
    await terminalEnded({
      widget: terminal.widget,
      session: terminal.session as unknown as Terminal.ITerminalConnection
    });
    terminal.widget.dispose();
  });
});
