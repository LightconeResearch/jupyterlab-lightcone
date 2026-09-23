import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { IThemeManager } from '@jupyterlab/apputils';
import {
  LIGHTCONE_DARK_THEME,
  LIGHTCONE_LIGHT_THEME,
  LIGHTCONE_THEME_STYLE,
  lightconeDarkThemePlugin,
  lightconeLightThemePlugin
} from '..';

function manager() {
  const registered: IThemeManager.ITheme[] = [];
  const loadCSS = jest.fn((path: string) => Promise.resolve());
  const register = jest.fn((theme: IThemeManager.ITheme) => {
    registered.push(theme);
    return { dispose: () => undefined, isDisposed: false };
  });
  const stub = { register, loadCSS } as unknown as IThemeManager;
  return { stub, registered, loadCSS };
}

const app = {} as JupyterFrontEnd;

describe('Lightcone theme plugins', () => {
  it('declare distinct ids and require the theme manager', () => {
    expect(lightconeLightThemePlugin.id).toBe(
      'jupyterlab_lightcone:theme-light'
    );
    expect(lightconeDarkThemePlugin.id).toBe('jupyterlab_lightcone:theme-dark');
    expect(lightconeLightThemePlugin.autoStart).toBe(true);
    expect(lightconeDarkThemePlugin.autoStart).toBe(true);
    expect(lightconeLightThemePlugin.requires).toHaveLength(1);
    expect(lightconeDarkThemePlugin.requires).toHaveLength(1);
  });

  it('register a light and a dark theme sharing one stylesheet', async () => {
    const { stub, registered, loadCSS } = manager();
    lightconeLightThemePlugin.activate(app, stub);
    lightconeDarkThemePlugin.activate(app, stub);

    expect(registered.map(theme => theme.name)).toEqual([
      LIGHTCONE_LIGHT_THEME,
      LIGHTCONE_DARK_THEME
    ]);
    expect(registered.map(theme => theme.isLight)).toEqual([true, false]);
    expect(registered.every(theme => theme.themeScrollbars === false)).toBe(
      true
    );
    expect(registered.map(theme => theme.displayName)).toEqual([
      'Lightcone Light',
      'Lightcone Dark'
    ]);

    for (const theme of registered) {
      await theme.load();
      await expect(theme.unload()).resolves.toBeUndefined();
    }
    expect(loadCSS).toHaveBeenCalledTimes(2);
    expect(
      loadCSS.mock.calls.every(call => call[0] === LIGHTCONE_THEME_STYLE)
    ).toBe(true);
  });

  it('point at the stylesheet the builder emits for this package', () => {
    expect(LIGHTCONE_THEME_STYLE).toBe('jupyterlab-lightcone/index.css');
  });
});
