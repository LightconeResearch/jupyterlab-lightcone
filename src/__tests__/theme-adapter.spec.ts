import { Signal } from '@lumino/signaling';
import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import { LightconeThemeBinding, colorScheme } from '../theme-adapter';

class FakeThemeManager implements IThemeManager {
  theme: string | null = null;
  themes: string[] = [];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = (theme: string) => theme.endsWith('Light');
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

describe('host theme binding', () => {
  it('tracks host light/dark changes and disconnects when disposed', () => {
    const manager = new FakeThemeManager();
    const target = document.createElement('div');
    const binding = new LightconeThemeBinding(manager, target);
    expect(colorScheme(manager)).toBe('light');
    manager.theme = 'JupyterLab Dark';
    manager.themeChanged.emit({
      name: 'theme',
      oldValue: 'JupyterLab Light',
      newValue: manager.theme
    });
    expect(target.dataset.astraColorScheme).toBe('dark');
    expect(target.dataset.lightconeColorScheme).toBe('dark');
    binding.dispose();
    binding.dispose();
    manager.theme = 'JupyterLab Light';
    manager.themeChanged.emit({
      name: 'theme',
      oldValue: 'JupyterLab Dark',
      newValue: manager.theme
    });
    expect(target.dataset.lightconeColorScheme).toBe('dark');
    expect(binding.isDisposed).toBe(true);
  });
});
