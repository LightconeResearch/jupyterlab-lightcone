import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, type IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import { CustomizeCommandIDs, CustomizeWidget, customizePlugin } from '..';
import { fetchSetup } from '../setup-api';

jest.mock('../setup-api', () => ({ fetchSetup: jest.fn() }));

class FakeCurrentProject implements ICurrentProject {
  project: IProjectRoot | null | undefined = null;
  readonly changed = new Signal<this, void>(this);
}

class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (name: string) => name;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

/** The settings tab a command execution returned. */
function settingsTab(value: unknown): MainAreaWidget<CustomizeWidget> {
  if (
    !(value instanceof MainAreaWidget) ||
    !(value.content instanceof CustomizeWidget)
  ) {
    throw new Error('The command did not return the settings tab.');
  }
  return value;
}

beforeEach(() => {
  jest.mocked(fetchSetup).mockReturnValue(new Promise(() => undefined));
});

it('keeps one settings tab, reveals it again and restores it', async () => {
  const commands = new CommandRegistry();
  const added: [Widget, string][] = [];
  const activated: string[] = [];
  const app = {
    commands,
    shell: {
      add: (widget: Widget, area: string) => added.push([widget, area]),
      activateById: (id: string) => activated.push(id)
    },
    serviceManager: { serverSettings: ServerConnection.makeSettings() }
  } as unknown as JupyterFrontEnd;
  const palette = { addItem: jest.fn() };
  const restorer = { restore: jest.fn(async () => undefined) };
  customizePlugin.activate(
    app,
    new FakeCurrentProject(),
    new FakeThemeManager(),
    palette,
    restorer,
    null
  );
  expect(palette.addItem).toHaveBeenCalledWith({
    command: CustomizeCommandIDs.openCustomize,
    category: 'Lightcone Lab'
  });
  expect(restorer.restore).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ command: CustomizeCommandIDs.openCustomize })
  );

  const first = settingsTab(
    await commands.execute(CustomizeCommandIDs.openCustomize)
  );
  const again = settingsTab(
    await commands.execute(CustomizeCommandIDs.openCustomize)
  );
  expect(again).toBe(first);
  expect(first.id).toBe('lightcone-customize');
  expect(first.title.label).toBe('Lightcone settings');
  expect(added).toEqual([[first, 'main']]);
  expect(activated).toEqual(['lightcone-customize', 'lightcone-customize']);

  // Closing the tab lets the command open a fresh one.
  first.dispose();
  const reopened = settingsTab(
    await commands.execute(CustomizeCommandIDs.openCustomize)
  );
  expect(reopened).not.toBe(first);
  expect(added).toHaveLength(2);
  reopened.dispose();
});
