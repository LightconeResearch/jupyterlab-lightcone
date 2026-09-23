import {
  ILabShell,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';

/** Commands of the focus layout. */
export namespace FocusLayoutCommandIDs {
  /** Toggle a calmer layout: no right sidebar, no status bar. */
  export const toggle = 'jupyterlab_lightcone:focus-layout';
}

/** JupyterLab's status bar toggle, registered by its status bar plugin. */
export const STATUS_BAR_TOGGLE = 'statusbar:toggle';

/** The part of the shell the focus layout drives. */
export interface IFocusShell {
  readonly rightCollapsed: boolean;
  collapseRight(): void;
  expandRight(): void;
}

/**
 * A calmer layout composed from JupyterLab's own switches: the right
 * sidebar collapses and the status bar hides; the menu bar stays, since
 * multiple-document mode has no public way to hide it. Leaving it restores
 * exactly what it changed.
 */
export class FocusLayout {
  constructor(
    private readonly _shell: IFocusShell,
    private readonly _commands: CommandRegistry
  ) {}

  get active(): boolean {
    return this._saved !== null;
  }

  async toggle(): Promise<void> {
    if (this._saved) {
      const saved = this._saved;
      this._saved = null;
      if (!saved.rightCollapsed) this._shell.expandRight();
      if (saved.statusBar && !this._statusBarShown()) {
        await this._commands.execute(STATUS_BAR_TOGGLE);
      }
      return;
    }
    const statusBar = this._statusBarShown();
    this._saved = { rightCollapsed: this._shell.rightCollapsed, statusBar };
    this._shell.collapseRight();
    if (statusBar) await this._commands.execute(STATUS_BAR_TOGGLE);
  }

  private _statusBarShown(): boolean {
    return (
      this._commands.hasCommand(STATUS_BAR_TOGGLE) &&
      this._commands.isToggled(STATUS_BAR_TOGGLE)
    );
  }

  private _saved: { rightCollapsed: boolean; statusBar: boolean } | null = null;
}

/** The Focus layout command, in the palette under Lightcone Lab. */
export const focusLayoutPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:focus-layout',
  description:
    'Toggle a calmer layout: collapse the right sidebar and hide the status bar.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    shell: ILabShell,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const layout = new FocusLayout(shell, app.commands);
    app.commands.addCommand(FocusLayoutCommandIDs.toggle, {
      label: trans.__('Focus Layout'),
      caption: trans.__(
        'Collapse the right sidebar and hide the status bar; run again to restore them'
      ),
      describedBy: { args: { type: 'object', properties: {} } },
      isToggled: () => layout.active,
      execute: async () => {
        await layout.toggle();
        app.commands.notifyCommandChanged(FocusLayoutCommandIDs.toggle);
      }
    });
    palette?.addItem({
      command: FocusLayoutCommandIDs.toggle,
      category: 'Lightcone Lab'
    });
  }
};
