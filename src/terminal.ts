import type { ILabShell } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { Terminal } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import { Widget, type DockLayout } from '@lumino/widgets';
import { isRecord } from './api';
import { pathTo, shownWidget } from './dock-layout';
import { TERMINAL_COMMAND } from './workbench-ids';

/** How long a new shell may stay silent before its prompt is taken as shown. */
const FIRST_OUTPUT_WAIT = 1000;

/** How long the shell must stay quiet after printing before the command is typed. */
const PROMPT_SETTLE = 300;

/** The longest wait for the prompt; the command is typed then regardless. */
const PROMPT_DEADLINE = 5000;

/** The longest wait for the terminal's connection before typing anyway. */
const CONNECT_DEADLINE = 10000;

/** Whether a value is a terminal's server connection, as its widget holds it. */
function isTerminalConnection(
  value: unknown
): value is Terminal.ITerminalConnection {
  return (
    isRecord(value) &&
    typeof value.send === 'function' &&
    isRecord(value.messageReceived) &&
    typeof value.messageReceived.connect === 'function' &&
    isRecord(value.connectionStatusChanged) &&
    typeof value.connectionStatusChanged.connect === 'function'
  );
}

/**
 * Settle once the connection to the shell is up. Until then the connection
 * drops the shell's output, so a prompt printed meanwhile would pass for a
 * silent shell and the command would be typed ahead of it.
 */
function connected(session: Terminal.ITerminalConnection): Promise<void> {
  return new Promise(resolve => {
    if (session.connectionStatus === 'connected') {
      resolve();
      return;
    }
    let deadline = 0;
    const onStatus = (
      _sender: Terminal.ITerminalConnection,
      status: Terminal.ITerminalConnection['connectionStatus']
    ): void => {
      if (status === 'connected') settle();
    };
    const settle = (): void => {
      window.clearTimeout(deadline);
      session.connectionStatusChanged.disconnect(onStatus);
      resolve();
    };
    session.connectionStatusChanged.connect(onStatus);
    deadline = window.setTimeout(settle, CONNECT_DEADLINE);
  });
}

/**
 * The text typed into a terminal opened at `cwd`. The terminal server
 * resolves the server root's empty path against the folder it was started in,
 * which need not be the root; its shells get the root as `$JUPYTER_SERVER_ROOT`.
 */
export function typedCommand(cwd: string, command: string): string {
  return cwd && cwd !== '.'
    ? command
    : `cd "$JUPYTER_SERVER_ROOT" && ${command}`;
}

/**
 * Settle once the shell has drawn its prompt: its output has gone quiet, or it
 * printed nothing at first (the prompt may have arrived before this listens).
 */
function promptShown(session: Terminal.ITerminalConnection): Promise<void> {
  return new Promise(resolve => {
    let idle = 0;
    let deadline = 0;
    const settle = (): void => {
      window.clearTimeout(idle);
      window.clearTimeout(deadline);
      session.messageReceived.disconnect(onMessage);
      resolve();
    };
    const onMessage = (
      _sender: Terminal.ITerminalConnection,
      message: Terminal.IMessage
    ): void => {
      if (message.type !== 'stdout') return;
      window.clearTimeout(idle);
      idle = window.setTimeout(settle, PROMPT_SETTLE);
    };
    session.messageReceived.connect(onMessage);
    idle = window.setTimeout(settle, FIRST_OUTPUT_WAIT);
    deadline = window.setTimeout(settle, PROMPT_DEADLINE);
  });
}

/**
 * Where a terminal opened from `opener` goes: a tab in the column on its
 * right when there is one, else a new column split off to its right, so the
 * opener stays in view beside the shell. `layout` is the dock's saved layout
 * (`ILabShell.saveLayout().mainArea.dock`).
 */
export function terminalPlacement(
  opener: Widget,
  layout: DockLayout.ILayoutConfig | null
): DocumentRegistry.IOpenOptions {
  const path = layout?.main ? pathTo(layout.main, opener) : undefined;
  // From the innermost horizontal split outwards, the first column on the right.
  for (let depth = (path?.length ?? 0) - 2; path && depth >= 0; depth -= 1) {
    const area = path[depth];
    if (area.type !== 'split-area' || area.orientation !== 'horizontal') {
      continue;
    }
    const right = area.children[area.children.indexOf(path[depth + 1]) + 1];
    const shown = right ? shownWidget(right) : undefined;
    if (shown) return { mode: 'tab-after', ref: shown.id };
  }
  return { mode: 'split-right', ref: opener.id };
}

export interface IOpenTerminalOptions {
  /** The Contents path of the folder the shell starts in. */
  cwd: string;
  /** Typed at the prompt: the user reads it and presses Enter, unless `run`. */
  command?: string;
  /** Press Enter after the command too, so it starts without the user. */
  run?: boolean;
  /**
   * The shell, to open the terminal beside the main-area tab that is current
   * when it is asked for (`terminalPlacement`). Without it, the terminal
   * opens where JupyterLab puts it, as a tab in the current area.
   */
  shell?: ILabShell | null;
}

/** A terminal tab `openTerminal` opened, with its connection to the shell. */
export interface IOpenedTerminal {
  widget: Widget;
  session: Terminal.ITerminalConnection | undefined;
}

/**
 * Open a terminal through JupyterLab's terminal command, beside the current
 * tab when given the shell, and type a command at its prompt, running it when
 * asked. Typing waits for the prompt, since text sent before the shell reads
 * it is echoed twice, once ahead of the prompt. Undefined when the command
 * opened no tab.
 */
export async function openTerminal(
  commands: CommandRegistry,
  options: IOpenTerminalOptions
): Promise<IOpenedTerminal | undefined> {
  const { cwd, command, run, shell } = options;
  const opener = shell?.currentWidget;
  const widget: unknown = await commands.execute(TERMINAL_COMMAND, { cwd });
  if (!(widget instanceof Widget)) return undefined;
  if (shell && opener && !opener.isDisposed && widget !== opener) {
    shell.add(
      widget,
      'main',
      terminalPlacement(opener, shell.saveLayout().mainArea?.dock ?? null)
    );
    shell.activateById(widget.id);
  }
  const content: unknown =
    widget instanceof MainAreaWidget ? widget.content : undefined;
  const session = isRecord(content) ? content.session : undefined;
  if (!isTerminalConnection(session)) return { widget, session: undefined };
  if (command) {
    await connected(session);
    await promptShown(session);
    if (!session.isDisposed) {
      const typed = typedCommand(cwd, command);
      session.send({ type: 'stdin', content: [run ? `${typed}\r` : typed] });
    }
  }
  return { widget, session };
}

/**
 * Settle when a terminal ends: its shell exits, which disposes the connection
 * as the server says `disconnect`, or its tab closes (the only sign left when
 * the tab holds no connection this can follow).
 */
export function terminalEnded({
  widget,
  session
}: IOpenedTerminal): Promise<void> {
  return new Promise(resolve => {
    if (widget.isDisposed || session?.isDisposed) {
      resolve();
      return;
    }
    const end = (): void => {
      widget.disposed.disconnect(end);
      session?.disposed.disconnect(end);
      resolve();
    };
    widget.disposed.connect(end);
    session?.disposed.connect(end);
  });
}
