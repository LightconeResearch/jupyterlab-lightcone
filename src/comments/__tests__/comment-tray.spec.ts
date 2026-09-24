import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import { ServerConnection } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { ChatProjects } from '../chat-projects';
import { listComments } from '../comments-api';
import { emptyAnchor, pointAnchor } from '../comment-model';
import { CommentService } from '../comment-service';
import { ChatCommentTrays, type ICommentTrayActions } from '../comment-tray';
import { makeComment, recordTarget, until } from './fixtures';

jest.mock('../comments-api', () => ({
  listComments: jest.fn(),
  createComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const HOST = '.jp-jupyterlab-lightcone-CommentTrayHost';
const CHIP = '.jp-jupyterlab-lightcone-CommentChip';

/** A chat panel as Jupyter Chat lays it out: messages, then the input. */
function fakePanel(area: 'main' | 'sidebar' = 'main') {
  const widget = new Widget();
  widget.node.innerHTML =
    '<div class="jp-chat-messages"></div>' +
    '<div class="jp-chat-input-container" data-input-id="in1"></div>';
  document.body.appendChild(widget.node);
  const panel = {
    area,
    widget,
    isDisposed: false,
    disposed: new Signal<object, void>({}),
    model: {
      name: 'project/chats/a.chat',
      input: { id: 'in1' },
      messagesUpdated: new Signal<object, void>({})
    }
  };
  return { panel, chat: panel as unknown as IChatPanel, widget };
}

/** A tracker that already knows `panels`. */
function fakeTracker(panels: IChatPanel[]) {
  const widgetAdded = new Signal<IChatTracker, IChatPanel>(
    {} as unknown as IChatTracker
  );
  const tracker = {
    widgetAdded,
    forEach: (callback: (panel: IChatPanel) => void) => panels.forEach(callback)
  };
  return { tracker: tracker as unknown as IChatTracker, widgetAdded };
}

function setup(panels: IChatPanel[]) {
  const { contents } = createContents({
    [ENTRYPOINT]: fileModel(analysis('demo')),
    'project/chats/a.chat': fileModel('{}')
  });
  const service = new CommentService(ServerConnection.makeSettings());
  const actions: jest.Mocked<ICommentTrayActions> = {
    open: jest.fn(),
    edit: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined)
  };
  const { tracker, widgetAdded } = fakeTracker(panels);
  const trays = new ChatCommentTrays(tracker, {
    service,
    projects: new ChatProjects(contents),
    actions,
    chatPath: panel => panel.model.name
  });
  return { service, actions, trays, widgetAdded };
}

const comment = makeComment('a', pointAnchor(10, 20), {
  text: 'The legend covers the high-redshift points.'
});

beforeEach(() => {
  jest.mocked(listComments).mockReset();
  jest.mocked(listComments).mockResolvedValue([comment]);
  document.body.innerHTML = '';
});

describe('ChatCommentTrays', () => {
  it('lists pending comments just above the chat input', async () => {
    const { chat, widget } = fakePanel();
    const { trays, actions } = setup([chat]);
    await until(() => !!widget.node.querySelector(CHIP));
    const host = widget.node.querySelector(HOST);
    expect(host?.nextElementSibling?.className).toBe('jp-chat-input-container');
    const chip = widget.node.querySelector<HTMLElement>(CHIP);
    expect(chip?.textContent).toContain('①');
    expect(chip?.getAttribute('title')).toBe(
      'The legend covers the high-redshift points. · outputs.hubble_diagram'
    );
    widget.node
      .querySelector<HTMLButtonElement>(
        '.jp-jupyterlab-lightcone-CommentChip-open'
      )
      ?.click();
    expect(actions.open).toHaveBeenCalledWith(comment);
    widget.node
      .querySelector<HTMLButtonElement>('[aria-label="Delete comment"]')
      ?.click();
    expect(actions.remove).toHaveBeenCalledWith(ENTRYPOINT, comment);
    trays.dispose();
  });

  it('leads a chip with its record’s kind mark, else its anchor icon', async () => {
    jest.mocked(listComments).mockResolvedValue([
      comment,
      makeComment('b', emptyAnchor('text'), {
        label: 2,
        target: recordTarget({ record: 'decisions.model' })
      }),
      makeComment('c', emptyAnchor('pdf'), {
        label: 3,
        target: recordTarget({ record: 'papers.10.1234/abc.def' })
      }),
      makeComment('d', emptyAnchor('text'), {
        label: 4,
        target: recordTarget({ record: 'sub.findings.h0.fig1' })
      }),
      makeComment('e', emptyAnchor('text'), {
        label: 5,
        target: recordTarget({
          kind: 'file',
          path: 'project/notes.md',
          record: null
        })
      })
    ]);
    const { chat, widget } = fakePanel();
    const { trays } = setup([chat]);
    await until(() => widget.node.querySelectorAll(CHIP).length === 5);
    const chips = Array.from(widget.node.querySelectorAll(CHIP));
    expect(
      chips.map(
        chip =>
          chip
            .querySelector(
              '.jp-jupyterlab-lightcone-CommentChip-kind.lightcone-brand.astra-ui > .astra-kind-glyph'
            )
            ?.getAttribute('data-kind') ?? null
      )
    ).toEqual(['output', 'decision', 'paper', 'finding', null]);
    // A file keeps the icon of its anchor.
    expect(
      chips[4].querySelector('.jp-jupyterlab-lightcone-CommentChip-icon svg')
    ).not.toBeNull();
    trays.dispose();
  });

  it('keeps an opening click from the chat, which would take the focus back', async () => {
    const { chat, widget } = fakePanel();
    // Jupyter Chat focuses its input on a click that leaves the focus outside.
    const chatClick = jest.fn();
    widget.node.addEventListener('click', chatClick);
    const { trays, actions } = setup([chat]);
    await until(() => !!widget.node.querySelector(CHIP));
    widget.node
      .querySelector<HTMLButtonElement>(
        '.jp-jupyterlab-lightcone-CommentChip-open'
      )
      ?.click();
    expect(actions.open).toHaveBeenCalledWith(comment);
    expect(chatClick).not.toHaveBeenCalled();
    trays.dispose();
  });

  it('follows the input when the chat renders it again', async () => {
    const { chat, widget } = fakePanel();
    const { trays } = setup([chat]);
    await until(() => !!widget.node.querySelector(CHIP));
    const replacement = document.createElement('div');
    replacement.className = 'jp-chat-input-container';
    replacement.dataset.inputId = 'in1';
    widget.node.querySelector('.jp-chat-input-container')?.remove();
    widget.node.appendChild(replacement);
    await until(
      () => widget.node.querySelector(HOST)?.nextElementSibling === replacement
    );
    trays.dispose();
    expect(widget.node.querySelector(HOST)).toBeNull();
  });

  it('fetches the pending list again after new messages', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    try {
      const { chat, panel, widget } = fakePanel();
      const { trays } = setup([chat]);
      await until(() => !!widget.node.querySelector(CHIP));
      const calls = jest.mocked(listComments).mock.calls.length;
      panel.model.messagesUpdated.emit();
      jest.advanceTimersByTime(1000);
      expect(jest.mocked(listComments).mock.calls.length).toBe(calls + 1);
      trays.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves side-panel chats alone and removes a tray with its chat', async () => {
    const side = fakePanel('sidebar');
    const main = fakePanel();
    const { trays, widgetAdded } = setup([side.chat]);
    widgetAdded.emit(main.chat);
    await until(() => !!main.widget.node.querySelector(CHIP));
    expect(side.widget.node.querySelector(HOST)).toBeNull();
    main.panel.disposed.emit();
    expect(main.widget.node.querySelector(HOST)).toBeNull();
    trays.dispose();
  });
});
