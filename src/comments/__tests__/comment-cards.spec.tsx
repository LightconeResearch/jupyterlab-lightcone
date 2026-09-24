import type { IChatModel, IMessageContent } from '@jupyter/chat';
import { ServerConnection } from '@jupyterlab/services';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatProjects } from '../chat-projects';
import { createCommentCards } from '../comment-cards';
import { pointAnchor } from '../comment-model';
import { CommentService } from '../comment-service';
import { makeComment, recordTarget } from './fixtures';

const CARD = '.jp-jupyterlab-lightcone-CommentCard';

// Tell React that updates are awaited with `act`.
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const sent = makeComment('s1', pointAnchor(42, 31), {
  status: 'sent',
  label: 2,
  text: 'The legend covers the high-redshift points.',
  target: recordTarget({
    version: {
      commit: 'a889877'.padEnd(40, '0'),
      key: null,
      hash: null,
      label: 'a889877'
    }
  })
});

function setup() {
  const service = new CommentService(ServerConnection.makeSettings());
  const all = jest
    .spyOn(service, 'all')
    .mockResolvedValue([sent, makeComment('x', pointAnchor(1, 1))]);
  const entrypointFor = jest.fn().mockResolvedValue('project/astra.yaml');
  const projects = { entrypointFor } as unknown as ChatProjects;
  const open = jest.fn();
  const Cards = createCommentCards({ service, projects, open });
  const node = document.createElement('div');
  const root = createRoot(node);
  const render = async (metadata: IMessageContent['metadata']) => {
    const model = { name: 'project/chats/a.chat' } as unknown as IChatModel;
    const message = { metadata } as unknown as IMessageContent;
    await act(async () => {
      root.render(<Cards model={model} message={message} />);
    });
  };
  return { node, root, render, all, entrypointFor, open };
}

describe('comment cards', () => {
  it('show the comments a message carried and open their target', async () => {
    const { node, root, render, open, entrypointFor } = setup();
    await render({ lightcone: { comments: ['s1'] } });
    expect(entrypointFor).toHaveBeenCalledWith('project/chats/a.chat');
    const cards = node.querySelectorAll<HTMLButtonElement>(CARD);
    expect(cards).toHaveLength(1);
    const text = cards[0].textContent ?? '';
    expect(text).toContain('②');
    expect(text).toContain('outputs.hubble_diagram');
    expect(text).toContain('version a889877');
    expect(text).toContain('point at 42% across, 31% down');
    expect(text).toContain('The legend covers the high-redshift points.');
    // The record's kind mark stands before its name, as in the inventory.
    const head = cards[0].querySelector(
      '.jp-jupyterlab-lightcone-CommentCard-head'
    );
    expect(
      head
        ?.querySelector(
          '.jp-jupyterlab-lightcone-CommentCard-kind.lightcone-brand.astra-ui > .astra-kind-glyph'
        )
        ?.getAttribute('data-kind')
    ).toBe('output');
    expect(
      head?.querySelector('.jp-jupyterlab-lightcone-CommentCard-icon')
    ).toBeNull();
    act(() => cards[0].click());
    expect(open).toHaveBeenCalledWith(sent);
    act(() => root.unmount());
  });

  it('render nothing for a message without comments', async () => {
    const { node, root, render, all } = setup();
    await render(undefined);
    expect(node.innerHTML).toBe('');
    expect(all).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
