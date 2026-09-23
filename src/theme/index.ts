import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';

/**
 * The stylesheet both themes load, relative to JupyterLab's themes URL.
 *
 * The builder compiles `jupyterlab.themePath` (package.json) into
 * `<labextension>/themes/<package name>/index.css`, and the server serves
 * every `themes` directory under the labextensions path at the themes URL.
 * `IThemeManager.loadCSS` joins that URL with this path.
 */
export const LIGHTCONE_THEME_STYLE = 'jupyterlab-lightcone/index.css';

/** The registered name of the light theme; also the `data-jp-theme-name`. */
export const LIGHTCONE_LIGHT_THEME = 'Lightcone Light';

/** The registered name of the dark theme; also the `data-jp-theme-name`. */
export const LIGHTCONE_DARK_THEME = 'Lightcone Dark';

/**
 * Register one of the Lightcone themes with the theme manager.
 *
 * Both themes share one stylesheet; its CSS selects the palette from the
 * `data-jp-theme-name` attribute JupyterLab stamps on `<body>`.
 * @param manager - JupyterLab's theme manager
 * @param name - The theme name to register
 * @param isLight - Whether the theme is a light theme
 */
function registerLightconeTheme(
  manager: IThemeManager,
  name: string,
  isLight: boolean
): void {
  manager.register({
    name,
    displayName: name,
    isLight,
    themeScrollbars: false,
    load: () => manager.loadCSS(LIGHTCONE_THEME_STYLE),
    unload: () => Promise.resolve(undefined)
  });
}

/** Adds the Lightcone Light theme built from the Lightcone brand. */
export const lightconeLightThemePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:theme-light',
  description: 'Adds the Lightcone Light theme.',
  autoStart: true,
  requires: [IThemeManager],
  activate: (app: JupyterFrontEnd, manager: IThemeManager): void => {
    registerLightconeTheme(manager, LIGHTCONE_LIGHT_THEME, true);
  }
};

/** Adds the Lightcone Dark theme built from the Lightcone brand. */
export const lightconeDarkThemePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:theme-dark',
  description: 'Adds the Lightcone Dark theme.',
  autoStart: true,
  requires: [IThemeManager],
  activate: (app: JupyterFrontEnd, manager: IThemeManager): void => {
    registerLightconeTheme(manager, LIGHTCONE_DARK_THEME, false);
  }
};
