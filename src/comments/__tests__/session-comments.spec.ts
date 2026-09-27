import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { MESSAGE_CONTAINER_CLASS } from '../../chat-links/chat-dom';
import { createChatProjectResolver } from '../../chat-links/chat-project';
import { fetchChatProject } from '../../sessions/sessions-api';
import { createComment, listComments } from '../comments-api';
import { emptyAnchor, NULL_VERSION } from '../comment-model';
import { CommentHosts } from '../comment-hosts';
import { CommentPopover, type IPopoverRequest } from '../comment-popover';
import { CommentService } from '../comment-service';
import { makeComment, rect, until } from './fixtures';

jest.mock('@jupyter/chat', () =>
  jest.requireActual('../../chat-links/__tests__/chat-mock')
);
jest.mock('../../sessions/sessions-api', () => ({
  fetchChatProject: jest.fn()
}));
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
const CHAT = 'project/chats/fit.chat';
const settings = ServerConnection.makeSettings();

let realCreateRange: PropertyDescriptor | undefined;
let rangePrototype: Range;
let saved: Pick<Range, 'getClientRects' | 'getBoundingClientRect'>;
const lineBoxes = new WeakMap<Node, DOMRect>();

beforeAll(() => {
  // As in selection-button.spec.ts: real ranges, with a fixed box since
  // jsdom has no layout.
  realCreateRange = Object.getOwnPropertyDescriptor(document, 'createRange');
  Reflect.deleteProperty(document, 'createRange');
  rangePrototype = Object.getPrototypeOf(document.createRange());
  saved = {
    getClientRects: rangePrototype.getClientRects,
    getBoundingClientRect: rangePrototype.getBoundingClientRect
  };
  const box = rect(150, 20, 50, 20);
  rangePrototype.getClientRects = function (this: Range) {
    const bounds = lineBoxes.get(this.startContainer) ?? box;
    return Object.assign([bounds], {
      item: (index: number) => (index === 0 ? bounds : null)
    }) as unknown as DOMRectList;
  };
  rangePrototype.getBoundingClientRect = () => box;
});

it('keeps a repeated quote on its message through reordering and deletion', async () => {
  jest.mocked(fetchChatProject).mockResolvedValue(ENTRYPOINT);
  const { contents } = createContents({
    [ENTRYPOINT]: fileModel(analysis('demo')),
    [CHAT]: fileModel('{}')
  });
  jest.mocked(listComments).mockResolvedValue([
    makeComment(
      'note',
      { ...emptyAnchor('text'), quote: 'Same reply' },
      {
        target: {
          kind: 'message',
          path: CHAT,
          record: null,
          universe: null,
          message: 'm-agent',
          version: NULL_VERSION
        }
      }
    )
  ]);
  const service = new CommentService(settings);
  await service.refresh(ENTRYPOINT);
  const panel = sessionPanel();
  const messages = Array.from(
    panel.node.querySelectorAll<HTMLElement>(`[data-index]`)
  );
  messages.forEach((message, index) => {
    message.textContent = 'Same reply';
    if (message.firstChild) {
      lineBoxes.set(message.firstChild, rect(150, 20 + 100 * index, 50, 20));
    }
  });
  const popover = new CommentPopover();
  const app = {
    serviceManager: { contents, serverSettings: settings },
    shell: { widgets: () => [], activateById: jest.fn() },
    restored: Promise.resolve(),
    docRegistry: { addWidgetExtension: () => ({ dispose: () => undefined }) },
    commands: { execute: jest.fn() }
  } as unknown as JupyterFrontEnd;
  const tracker = {
    forEach: (callback: (item: IChatPanel) => void) => callback(panel),
    widgetAdded: new Signal<IChatTracker, IChatPanel>({} as IChatTracker)
  } as unknown as IChatTracker;
  const hosts = new CommentHosts({
    app,
    shell: null,
    documents: null,
    tracker,
    projects: createChatProjectResolver(contents, () => undefined),
    service,
    popover
  });
  const badge = () =>
    panel.node.querySelector<HTMLElement>(
      '.jp-jupyterlab-lightcone-CommentBadge'
    );
  try {
    await until(() => badge() !== null);
    expect(badge()?.style.top).toBe('130px');
    // Message indices change when the transcript is reordered; IDs do not.
    Object.assign(panel.model, {
      messages: [{ id: 'm-agent' }, { id: 'm-user' }]
    });
    messages[1].dataset.index = '0';
    messages[0].dataset.index = '1';
    panel.widget.node.insertBefore(messages[1], messages[0]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(badge()?.style.top).toBe('130px');
    Object.assign(panel.model, { messages: [{ id: 'm-user' }] });
    messages[0].dataset.index = '0';
    messages[1].remove();
    await until(() => badge() === null);
    expect(
      panel.node.querySelector('.jp-jupyterlab-lightcone-CommentHighlight')
    ).toBeNull();
  } finally {
    hosts.dispose();
    popover.dispose();
    panel.dispose();
    service.dispose();
    contents.dispose();
  }
});

afterAll(() => {
  rangePrototype.getClientRects = saved.getClientRects;
  rangePrototype.getBoundingClientRect = saved.getBoundingClientRect;
  if (realCreateRange) {
    Object.defineProperty(document, 'createRange', realCreateRange);
  }
});

/** A main-area session whose transcript holds two rendered messages. */
function sessionPanel(): MainAreaWidget & IChatPanel {
  const content = new Widget();
  content.node.innerHTML =
    `<div class="${MESSAGE_CONTAINER_CLASS}" data-index="0"><p>Fit the model</p></div>` +
    `<div class="${MESSAGE_CONTAINER_CLASS}" data-index="1"><p>I used a flat prior on Omega_m.</p></div>`;
  const panel = new MainAreaWidget({ content });
  Object.assign(panel, {
    area: 'main',
    widget: content,
    model: {
      name: CHAT,
      input: {},
      messages: [{ id: 'm-user' }, { id: 'm-agent' }]
    }
  });
  Widget.attach(panel, document.body);
  return panel as MainAreaWidget & IChatPanel;
}

it('comments on a selection in a session message, pointing at that message', async () => {
  jest.mocked(fetchChatProject).mockResolvedValue(ENTRYPOINT);
  const { contents } = createContents({
    [ENTRYPOINT]: fileModel(analysis('demo')),
    [CHAT]: fileModel('{}')
  });
  jest.mocked(listComments).mockResolvedValue([]);
  const service = new CommentService(settings);
  await service.refresh(ENTRYPOINT);
  const panel = sessionPanel();
  const popover = new CommentPopover();
  const requests: IPopoverRequest[] = [];
  jest.spyOn(popover, 'open').mockImplementation(request => {
    requests.push(request);
  });
  const app = {
    serviceManager: { contents, serverSettings: settings },
    shell: { widgets: () => [], activateById: jest.fn() },
    restored: Promise.resolve(),
    docRegistry: { addWidgetExtension: () => ({ dispose: () => undefined }) },
    commands: { execute: jest.fn() }
  } as unknown as JupyterFrontEnd;
  // Sessions come from the chat tracker, not from a scan of the shell.
  const tracker = {
    forEach: (callback: (item: IChatPanel) => void) =>
      [panel].forEach(callback),
    widgetAdded: new Signal<IChatTracker, IChatPanel>({} as IChatTracker)
  } as unknown as IChatTracker;
  const hosts = new CommentHosts({
    app,
    shell: null,
    documents: null,
    tracker,
    projects: createChatProjectResolver(contents, () => undefined),
    service,
    popover
  });
  try {
    await until(() => true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchChatProject).toHaveBeenCalledWith(
      contents.serverSettings,
      CHAT
    );
    const text = panel.node.querySelector('[data-index="1"] p')?.firstChild;
    if (!(text instanceof Text)) throw new Error('No message text.');
    const range = document.createRange();
    range.setStart(text, 9);
    range.setEnd(text, 30);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const button = () =>
      document.querySelector<HTMLButtonElement>(
        '.jp-jupyterlab-lightcone-CommentButton[data-floating]'
      );
    await until(() => button()?.hidden === false);
    button()!.click();
    expect(requests).toHaveLength(1);
    jest
      .mocked(createComment)
      .mockResolvedValue(makeComment('n', emptyAnchor('text')));
    await requests[0].onSave('Why this prior?');
    expect(createComment).toHaveBeenCalledWith(settings, ENTRYPOINT, {
      text: 'Why this prior?',
      target: {
        kind: 'message',
        path: CHAT,
        record: null,
        universe: null,
        message: 'm-agent',
        version: NULL_VERSION
      },
      anchor: {
        ...emptyAnchor('text'),
        quote: 'flat prior on Omega_m',
        prefix: 'I used a '
      }
    });
  } finally {
    hosts.dispose();
    popover.dispose();
    panel.dispose();
    service.dispose();
    contents.dispose();
  }
});
