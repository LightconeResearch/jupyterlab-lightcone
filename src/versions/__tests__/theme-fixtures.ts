import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';

/**
 * A theme manager the test drives: `setTheme` switches the theme and
 * announces it as the Lab does. A theme whose name ends in "Light" is light.
 */
export class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes = ['JupyterLab Light', 'JupyterLab Dark'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = (theme: string) => theme.endsWith('Light');
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);

  async setTheme(name: string): Promise<void> {
    const oldValue = this.theme;
    this.theme = name;
    this.themeChanged.emit({ name: 'theme', oldValue, newValue: name });
  }
}
