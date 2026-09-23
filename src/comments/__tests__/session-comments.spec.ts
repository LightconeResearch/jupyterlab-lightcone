import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { createComment, listComments } from '../comments-api';
import { emptyAnchor, NULL_VERSION } from '../comment-model';
import { CommentHosts } from '../comment-hosts';
import { CommentPopover, type IPopoverRequest } from '../comment-popover';
import { CommentService } from '../comment-service';
import { makeComment, rect, until } from './fixtures';

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
  rangePrototype.getClientRects = () =>
    Object.assign([box], {
      item: (index: number) => (index === 0 ? box : null)
    }) as unknown as DOMRectList;
  rangePrototype.getBoundingClientRect = () => box;
});

afterAll(() => {
  rangePrototype.getClientRects = saved.getClientRects;
  rangePrototype.getBoundingClientRect = saved.getBoundingClientRect;
  if (realCreateRange) {
    Object.defineProperty(document, 'createRange', realCreateRange);
  }
});

/** A main-area session whose transcript holds two rendered messages. */
function sessionPanel(): MainAreaWidget {
  const content = new Widget();
  content.node.innerHTML =
    '<div class="jp-chat-message-container" data-index="0"><p>Fit the model</p></div>' +
    '<div class="jp-chat-message-container" data-index="1"><p>I used a flat prior on Omega_m.</p></div>';
  const panel = new MainAreaWidget({ content });
  Object.assign(panel, {
    area: 'main',
    model: {
      name: CHAT,
      input: {},
      messages: [{ id: 'm-user' }, { id: 'm-agent' }]
    }
  });
  Widget.attach(panel, document.body);
  return panel;
}

it('comments on a selection in a session message, pointing at that message', async () => {
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
    shell: { widgets: () => [panel], activateById: jest.fn() },
    restored: Promise.resolve(),
    docRegistry: { addWidgetExtension: () => ({ dispose: () => undefined }) },
    commands: { execute: jest.fn() }
  } as unknown as JupyterFrontEnd;
  const hosts = new CommentHosts({
    app,
    shell: null,
    documents: null,
    service,
    popover
  });
  try {
    hosts.scan();
    await until(() => true);
    await new Promise(resolve => setTimeout(resolve, 20));
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
