import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';

/** Optional shell theme; component branding follows any installed host theme. */
export const themePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:theme',
  description: 'Register the optional Lightcone Light theme.',
  autoStart: true,
  requires: [IThemeManager],
  activate: (_app: JupyterFrontEnd, manager: IThemeManager) => {
    let restoreScope: (() => void) | undefined;
    manager.register({
      name: 'Lightcone Light',
      displayName: 'Lightcone Light',
      isLight: true,
      themeScrollbars: true,
      load: async () => {
        const root = document.documentElement;
        const hadClass = root.classList.contains('lightcone-brand');
        const previousScheme = root.dataset.lightconeColorScheme;
        root.classList.add('lightcone-brand');
        root.dataset.lightconeColorScheme = 'light';
        restoreScope ??= () => {
          if (!hadClass) {
            root.classList.remove('lightcone-brand');
          }
          if (previousScheme === undefined) {
            delete root.dataset.lightconeColorScheme;
          } else {
            root.dataset.lightconeColorScheme = previousScheme;
          }
        };
        try {
          await manager.loadCSS(
            'jupyterlab-lightcone/index.css'
          );
        } catch (error) {
          restoreScope();
          restoreScope = undefined;
          throw error;
        }
      },
      unload: async () => {
        restoreScope?.();
        restoreScope = undefined;
      }
    });
  }
};
