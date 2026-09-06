import type { IThemeManager } from '@jupyterlab/apputils';

export type ColorScheme = 'light' | 'dark';

type ThemeManager = Pick<IThemeManager, 'theme' | 'isLight' | 'themeChanged'>;

type ColorSchemeTarget = Pick<HTMLElement, 'dataset'>;

export function colorScheme(manager: ThemeManager): ColorScheme {
  const theme = manager.theme;
  return theme === null || manager.isLight(theme) ? 'light' : 'dark';
}

/** Keep a branded ASTRA root synchronized with JupyterLab's active theme. */
export class LightconeThemeBinding {
  constructor(
    private readonly manager: ThemeManager,
    private readonly target: ColorSchemeTarget
  ) {
    this._sync();
    this.manager.themeChanged.connect(this._sync);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.manager.themeChanged.disconnect(this._sync);
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  private _sync = (): void => {
    const scheme = colorScheme(this.manager);
    this.target.dataset.astraColorScheme = scheme;
    this.target.dataset.lightconeColorScheme = scheme;
  };

  private _isDisposed = false;
}
