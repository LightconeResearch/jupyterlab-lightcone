import { MainAreaWidget, type IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { createFileContext } from '@jupyterlab/docregistry/lib/testutils';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { InventoryDocument } from '../../document-widget';
import { ElementWidget } from '../../element-widget';
import { createContents } from '../../__tests__/project-fixtures';
import { describeWidget, viewChanges } from '../current-view';
import { FakeChatPanel } from './sidebar-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

const documents = { openOrReveal: jest.fn() };

describe('describeWidget', () => {
  it('recognizes sessions and the views that state themselves', () => {
    expect(describeWidget(null)).toEqual({});
    expect(describeWidget(new Widget())).toEqual({});
    expect(
      describeWidget(new FakeChatPanel('project/chats/hubble.chat'))
    ).toEqual({ session: 'project/chats/hubble.chat' });

    const inventory = Object.assign(new Widget(), {
      lightconeView: true as const,
      entrypoint: 'project/astra.yaml',
      analysisPath: undefined as string | undefined,
      scopeChanged: new Signal<object, void>({})
    });
    expect(describeWidget(inventory)).toEqual({
      inventory: 'project/astra.yaml'
    });
    // Once loaded, the inventory names the analysis it shows.
    inventory.analysisPath = 'systematics';
    expect(describeWidget(inventory)).toEqual({
      inventory: 'project/astra.yaml',
      analysisPath: 'systematics'
    });

    // A record tab states its view through the content of its main-area widget.
    const record = Object.assign(new Widget(), {
      lightconeView: true as const,
      entrypoint: 'project/astra.yaml',
      reference: {
        target: 'outputs.hubble_diagram',
        doi: null as string | null
      }
    });
    const tab = new MainAreaWidget({ content: record });
    expect(describeWidget(tab)).toEqual({
      record: {
        entrypoint: 'project/astra.yaml',
        target: 'outputs.hubble_diagram'
      }
    });
    record.reference.doi = '10.1234/abc';
    expect(describeWidget(tab).record?.doi).toBe('10.1234/abc');

    // A view showing neither a record nor an analysis highlights nothing.
    const other = Object.assign(new Widget(), {
      lightconeView: true as const,
      entrypoint: 'project/astra.yaml'
    });
    expect(describeWidget(other)).toEqual({});
    // Any other widget, wrapped or not, is not a view.
    expect(
      describeWidget(new MainAreaWidget({ content: new Widget() }))
    ).toEqual({});
  });
});

describe('viewChanges', () => {
  it('names the signals that change a view in place', () => {
    const historyChanged = new Signal<object, void>({});
    const scopeChanged = new Signal<object, void>({});
    expect(viewChanges(null)).toEqual([]);
    expect(viewChanges(new Widget())).toEqual([]);

    const chat = new FakeChatPanel('project/chats/hubble.chat');
    expect(viewChanges(chat)).toEqual([chat.context.pathChanged]);

    const record = Object.assign(new Widget(), {
      lightconeView: true as const,
      entrypoint: 'project/astra.yaml',
      reference: { target: 'outputs.hubble_diagram' },
      historyChanged
    });
    expect(viewChanges(new MainAreaWidget({ content: record }))).toEqual([
      historyChanged
    ]);

    const inventory = Object.assign(new Widget(), {
      lightconeView: true as const,
      entrypoint: 'project/astra.yaml',
      scopeChanged
    });
    expect(viewChanges(inventory)).toEqual([scopeChanged]);
  });
});

// The fakes above satisfy the view interface; these hold the real widgets to
// it, so a renamed member fails here rather than in the running app.
describe('the widgets the sidebar recognizes', () => {
  it('describes and follows a real record tab', () => {
    const { contents } = createContents({});
    const content = new ElementWidget(
      {
        entrypoint: 'project/astra.yaml',
        target: 'outputs.hubble_diagram',
        doi: '10.1234/abc'
      },
      contents,
      new FakeThemeManager(),
      new CommandRegistry(),
      documents,
      'identity',
      'lightcone-element-test'
    );
    const tab = new MainAreaWidget({ content });
    try {
      expect(describeWidget(tab)).toEqual({
        record: {
          entrypoint: 'project/astra.yaml',
          target: 'outputs.hubble_diagram',
          doi: '10.1234/abc'
        }
      });
      expect(viewChanges(tab)).toEqual([content.historyChanged]);
    } finally {
      tab.dispose();
      contents.dispose();
    }
  });

  it('describes and follows a real inventory document', () => {
    const { contents } = createContents({});
    const context = createFileContext('project/astra.yaml');
    const inventory = new InventoryDocument(
      context,
      contents,
      new FakeThemeManager(),
      documents
    );
    try {
      // The project has not loaded, so no analysis is shown yet.
      expect(describeWidget(inventory)).toEqual({
        inventory: 'project/astra.yaml'
      });
      expect(viewChanges(inventory)).toEqual([
        context.pathChanged,
        inventory.content.scopeChanged
      ]);
    } finally {
      inventory.dispose();
      context.dispose();
      contents.dispose();
    }
  });
});
