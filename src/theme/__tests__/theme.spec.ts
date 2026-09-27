import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';
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

/** The fields of package.json that decide where the theme is served. */
interface IThemedPackage {
  name: string;
  jupyterlab: { themePath: string };
}

/**
 * Whether a parsed package.json names the package and its theme stylesheet.
 * @param value - The parsed manifest
 * @returns True when `name` and `jupyterlab.themePath` are strings
 */
function isThemedPackage(value: unknown): value is IThemedPackage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'jupyterlab' in value &&
    typeof value.jupyterlab === 'object' &&
    value.jupyterlab !== null &&
    'themePath' in value.jupyterlab &&
    typeof value.jupyterlab.themePath === 'string'
  );
}

describe('Lightcone theme plugins', () => {
  it('declare distinct ids and require the theme manager', () => {
    expect(lightconeLightThemePlugin.id).toBe(
      'jupyterlab_lightcone:theme-light'
    );
    expect(lightconeDarkThemePlugin.id).toBe('jupyterlab_lightcone:theme-dark');
    expect(lightconeLightThemePlugin.autoStart).toBe(true);
    expect(lightconeDarkThemePlugin.autoStart).toBe(true);
    expect(lightconeLightThemePlugin.requires).toEqual([IThemeManager]);
    expect(lightconeDarkThemePlugin.requires).toEqual([IThemeManager]);
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
    const root = join(__dirname, '..', '..', '..');
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, 'package.json'), { encoding: 'utf8' })
    );
    if (!isThemedPackage(manifest)) {
      throw new Error('package.json declares no jupyterlab.themePath');
    }
    // The builder emits `themePath` as `themes/<package name>/index.css`,
    // which the server publishes under the themes URL `loadCSS` joins.
    expect(LIGHTCONE_THEME_STYLE).toBe(`${manifest.name}/index.css`);
    expect(manifest.jupyterlab.themePath).toBe('style/themes/index.css');
    expect(existsSync(join(root, manifest.jupyterlab.themePath))).toBe(true);
  });
});
