import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, Notification } from '@jupyterlab/apputils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServerConnection, type Contents } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { acquireProjectDataService } from '../../project-data-service';
import { listVersions, type IOutputVersion } from '../../versions/versions-api';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { createComment, listComments, type IComment } from '../comments-api';
import { emptyAnchor, NULL_VERSION, pointAnchor } from '../comment-model';
import { CommentHosts, recordVersion } from '../comment-hosts';
import { CommentPopover, type IPopoverRequest } from '../comment-popover';
import { CommentService } from '../comment-service';
import { editorCommentExtension } from '../editor-comments';
import { COMMENT_LAYER_CLASS } from '../image-layer';
import {
  Frames,
  makeComment,
  placeAt,
  pointer,
  rect,
  settle
} from './fixtures';

jest.mock('../comments-api', () => ({
  listComments: jest.fn(),
  createComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn()
}));
jest.mock('../../versions/versions-api', () => ({ listVersions: jest.fn() }));
jest.mock('../../project-data-service', () => ({
  acquireProjectDataService: jest.fn()
}));
jest.mock('../../commands', () => ({
  CommandIDs: { openElement: 'jupyterlab_lightcone:open-element' }
}));
jest.mock('../../element-widget', () => {
  const { Widget: LuminoWidget } = jest.requireActual('@lumino/widgets');
  return { ElementWidget: class ElementWidget extends LuminoWidget {} };
});

const ENTRYPOINT = 'project/astra.yaml';
const BADGE = '.jp-jupyterlab-lightcone-CommentBadge';
const FLASH = 'jp-jupyterlab-lightcone-CommentFlash';
const settings = ServerConnection.makeSettings();

type WidgetExtension = DocumentRegistry.IWidgetExtension<
  Widget,
  DocumentRegistry.IModel
>;

/** The part of JupyterLab the hosts use, with the widget extensions kept. */
function fakeApp(contents: Contents.IManager) {
  const extensions = new Map<string, WidgetExtension>();
  const execute = jest.fn<Promise<unknown>, [string, unknown?]>();
  const app = {
    serviceManager: { contents, serverSettings: settings },
    shell: { widgets: () => [], activateById: jest.fn() },
    restored: Promise.resolve(),
    docRegistry: {
      addWidgetExtension: (factory: string, extension: WidgetExtension) => {
        extensions.set(factory, extension);
        return new DisposableDelegate(() => extensions.delete(factory));
      }
    },
    commands: { execute }
  };
  return { app: app as unknown as JupyterFrontEnd, extensions, execute };
}

/** A document context that loads when the test says so. */
function fakeContext(path: string) {
  const ready = new PromiseDelegate<void>();
  const state = {
    path,
    pathChanged: new Signal<object, string>({}),
    ready: ready.promise,
    isReady: false,
    contentsModel: { hash: 'h1' }
  };
  return {
    context: state as unknown as DocumentRegistry.Context,
    load: () => {
      state.isReady = true;
      ready.resolve();
    }
  };
}

function textComment(id: string, quote: string): IComment {
  return makeComment(
    id,
    { ...emptyAnchor('text'), quote },
    {
      target: {
        kind: 'file',
        path: 'project/index.md',
        record: null,
        universe: null,
        message: null,
        version: NULL_VERSION
      }
    }
  );
}

let frames: Frames;
let hosts: CommentHosts | null = null;
let popover: CommentPopover;
let requests: IPopoverRequest[];

beforeEach(() => {
  jest.mocked(listComments).mockReset();
  jest.mocked(createComment).mockReset();
  frames = new Frames();
  frames.install();
  popover = new CommentPopover();
  requests = [];
  jest.spyOn(popover, 'open').mockImplementation(request => {
    requests.push(request);
  });
  document.body.innerHTML = '';
});

afterEach(() => {
  hosts?.dispose();
  hosts = null;
  popover.dispose();
  jest.restoreAllMocks();
});

/** Hosts over a project holding `project/astra.yaml`, with one pending comment. */
async function setup(pending: IComment[]) {
  const { contents } = createContents({
    [ENTRYPOINT]: fileModel(analysis('demo')),
    'project/index.md': fileModel('text'),
    'project/fig.png': fileModel('png'),
    'loose/fig.png': fileModel('png')
  });
  jest.mocked(listComments).mockResolvedValue(pending);
  const service = new CommentService(settings);
  await service.refresh(ENTRYPOINT);
  const fake = fakeApp(contents);
  hosts = new CommentHosts({
    app: fake.app,
    shell: null,
    documents: null,
    service,
    popover
  });
  return { ...fake, service, hosts };
}

/** A file editor whose CodeMirror view carries the comment extension. */
function editorWidget(current: CommentHosts) {
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: editorCommentExtension(current.editorHandlers)
    }),
    parent: document.body
  });
  const content = new Widget();
  Object.assign(content, { editor: { editor: view } });
  return { widget: new MainAreaWidget({ content }), view };
}

function extension(
  extensions: Map<string, WidgetExtension>,
  factory: string
): WidgetExtension {
  const found = extensions.get(factory);
  if (!found) {
    throw new Error(`No widget extension for ${factory}.`);
  }
  return found;
}

describe('editor hosts', () => {
  it('mark comments once the text loads after the project is known', async () => {
    const { extensions } = await setup([textComment('a', 'magnitude offset')]);
    if (!hosts) {
      throw new Error('No hosts.');
    }
    const { widget, view } = editorWidget(hosts);
    const { context, load } = fakeContext('project/index.md');
    extension(extensions, 'Editor').createNew(widget, context);
    // The project is found while the document is still loading.
    await settle();
    expect(view.dom.querySelector(BADGE)).toBeNull();
    view.dispatch({
      changes: { from: 0, insert: 'The magnitude offset is profiled.' }
    });
    load();
    await settle();
    const badge = view.dom.querySelector<HTMLElement>(BADGE);
    expect(badge?.textContent).toBe('①');
    view.destroy();
  });

  it('scroll to a comment of a document opened from a chip', async () => {
    const comment = textComment('a', 'magnitude offset');
    const { extensions, execute } = await setup([comment]);
    const current = hosts;
    if (!current) {
      throw new Error('No hosts.');
    }
    const { widget, view } = editorWidget(current);
    const { context, load } = fakeContext('project/index.md');
    execute.mockImplementation(async command => {
      expect(command).toBe('docmanager:open');
      extension(extensions, 'Editor').createNew(widget, context);
      return widget;
    });
    await current.openTarget(comment);
    await settle();
    view.dispatch({
      changes: { from: 0, insert: 'The magnitude offset is profiled.' }
    });
    load();
    await settle();
    await frames.flush(40);
    const badge = view.dom.querySelector<HTMLElement>(BADGE);
    expect(badge?.classList).toContain(FLASH);
    view.destroy();
  });

  it('give up a flash the loaded document cannot show', async () => {
    const comment = textComment('a', 'absent quote');
    const { extensions, execute, service } = await setup([comment]);
    const current = hosts;
    if (!current) {
      throw new Error('No hosts.');
    }
    const { widget, view } = editorWidget(current);
    const { context, load } = fakeContext('project/index.md');
    extension(extensions, 'Editor').createNew(widget, context);
    view.dispatch({ changes: { from: 0, insert: 'unrelated text' } });
    load();
    await settle();
    const scroll = jest.spyOn(EditorView, 'scrollIntoView');
    // The document is open and settled: the chip finds nothing to show...
    execute.mockResolvedValue(widget);
    await current.openTarget(comment);
    // ...and a later refresh that finds the quote does not jump to it.
    view.dispatch({ changes: { from: 0, insert: 'absent quote ' } });
    jest
      .mocked(listComments)
      .mockResolvedValue([{ ...comment, text: 'edited' }]);
    await service.refresh(ENTRYPOINT);
    await settle();
    expect(view.dom.querySelector(BADGE)).not.toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('image hosts', () => {
  function imageWidget() {
    const content = new Widget();
    const image = document.createElement('img');
    content.node.appendChild(image);
    document.body.appendChild(content.node);
    placeAt(content.node, rect(0, 0, 400, 300));
    placeAt(image, rect(0, 0, 200, 100));
    return { widget: new MainAreaWidget({ content }), image, content };
  }

  async function clickAt(image: HTMLImageElement, x: number, y: number) {
    await frames.flush();
    image.dispatchEvent(pointer('pointerdown', { clientX: x, clientY: y }));
    image.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y
      })
    );
  }

  it('save a point comment on the image with its version', async () => {
    const { extensions } = await setup([]);
    const { widget, image, content } = imageWidget();
    const { context } = fakeContext('project/fig.png');
    extension(extensions, 'Image').createNew(widget, context);
    await settle();
    const layer = content.node.querySelector(`.${COMMENT_LAYER_CLASS}`);
    if (layer) {
      placeAt(layer, rect(0, 0, 400, 300));
    }
    await clickAt(image, 50, 25);
    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe('compose');
    const saved = makeComment('n', pointAnchor(25, 25));
    jest.mocked(createComment).mockResolvedValue(saved);
    await requests[0].onSave('note');
    expect(createComment).toHaveBeenCalledWith(settings, ENTRYPOINT, {
      text: 'note',
      target: {
        kind: 'file',
        path: 'project/fig.png',
        record: null,
        universe: null,
        message: null,
        version: { ...NULL_VERSION, hash: 'h1' }
      },
      anchor: pointAnchor(25, 25)
    });
  });

  it('refuse comments outside every project', async () => {
    const warning = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const { extensions } = await setup([]);
    const { widget, image } = imageWidget();
    const { context } = fakeContext('loose/fig.png');
    extension(extensions, 'Image').createNew(widget, context);
    await settle();
    await clickAt(image, 50, 25);
    expect(requests).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('outside every project'),
      expect.anything()
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe('recordVersion', () => {
  const release = jest.fn();
  const version = (commit: string): IOutputVersion => ({
    commit,
    short: commit.slice(0, 7),
    time: '2026-09-23T10:00:00Z',
    subject: 'materialize',
    key: `SHA256E-s8--${commit.slice(0, 4)}.png`,
    size: 8,
    present: true,
    run: null,
    manifest: null
  });

  beforeEach(() => {
    release.mockReset();
    jest.mocked(listVersions).mockReset();
    const data = {
      index: {
        recordByPath: new Map([
          ['outputs.hubble_diagram', { kind: 'output', id: 'hubble_diagram' }],
          ['decisions.model', { kind: 'decision', id: 'model' }]
        ])
      },
      document: { universe: { universeId: 'baseline' } }
    };
    jest.mocked(acquireProjectDataService).mockReturnValue({
      service: { get: async () => data },
      release
    } as unknown as ReturnType<typeof acquireProjectDataService>);
  });

  it('pins an output comment to its newest committed version', async () => {
    const { contents } = createContents({});
    jest.mocked(listVersions).mockResolvedValue({
      file: 'results/baseline/hubble_diagram.png',
      versions: [version('c'.repeat(40)), version('d'.repeat(40))]
    });
    await expect(
      recordVersion(
        contents,
        settings,
        ENTRYPOINT,
        'outputs.hubble_diagram',
        null
      )
    ).resolves.toEqual({
      commit: 'c'.repeat(40),
      key: 'SHA256E-s8--cccc.png',
      hash: null,
      label: 'ccccccc'
    });
    expect(listVersions).toHaveBeenCalledWith(
      settings,
      ENTRYPOINT,
      'baseline',
      'hubble_diagram'
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('leaves other records and failures unversioned', async () => {
    const { contents } = createContents({});
    await expect(
      recordVersion(contents, settings, ENTRYPOINT, 'decisions.model', null)
    ).resolves.toEqual(NULL_VERSION);
    expect(listVersions).not.toHaveBeenCalled();
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    jest.mocked(listVersions).mockRejectedValue(new Error('no git'));
    await expect(
      recordVersion(
        contents,
        settings,
        ENTRYPOINT,
        'outputs.hubble_diagram',
        null
      )
    ).resolves.toEqual(NULL_VERSION);
    expect(warn).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
