import { useChatContext } from '@jupyter/chat';
import type { ContentsManager } from '@jupyterlab/services';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  analysis,
  createContents,
  fileModel
} from '../../__tests__/project-fixtures';
import { SessionPlaceholderFactory } from '../session-placeholder';

jest.mock('@jupyter/chat', () => ({ useChatContext: jest.fn() }));
jest.mock('../../pdf-runtime', () => ({}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CLASS = 'jp-jupyterlab-lightcone-SessionPlaceholder';

/** Render the placeholder of the chat stored at `name`, and let it settle. */
async function render(
  contents: ContentsManager,
  name: string,
  settled: (node: HTMLElement) => boolean
): Promise<{ node: HTMLElement; unmount: () => void }> {
  jest
    .mocked(useChatContext)
    .mockReturnValue({ model: { name } } as unknown as ReturnType<
      typeof useChatContext
    >);
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const factory = new SessionPlaceholderFactory(contents);
  await act(async () => root.render(factory.create()));
  for (let attempt = 0; attempt < 100 && !settled(node); attempt++) {
    await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  }
  return {
    node,
    unmount: () => {
      act(() => root.unmount());
      node.remove();
    }
  };
}

describe('SessionPlaceholderFactory', () => {
  it('names the project that owns the chat', async () => {
    const { contents } = createContents({
      'project/astra.yaml': fileModel(analysis('Union 2.1 cosmology'))
    });
    const view = await render(
      contents,
      'project/chats/hubble.chat',
      node => !!node.querySelector(`.${CLASS}-project`)
    );
    try {
      expect(view.node.querySelector(`.${CLASS}-project`)?.textContent).toBe(
        'Union 2.1 cosmology'
      );
      expect(view.node.querySelector(`.${CLASS}-prompt`)?.textContent).toBe(
        'What would you like to explore?'
      );
    } finally {
      view.unmount();
      contents.dispose();
    }
  });

  it('shows only the invitation for a chat outside every project', async () => {
    const { contents, get } = createContents({
      'project/astra.yaml': fileModel(analysis('Union 2.1 cosmology'))
    });
    const view = await render(contents, 'loose/notes.chat', () =>
      get.mock.calls.some(([path]) => path === 'astra.yaml')
    );
    try {
      await act(() => new Promise(resolve => setTimeout(resolve, 10)));
      expect(view.node.querySelector(`.${CLASS}-project`)).toBeNull();
      expect(view.node.querySelector(`.${CLASS}-prompt`)?.textContent).toBe(
        'What would you like to explore?'
      );
    } finally {
      view.unmount();
      contents.dispose();
    }
  });

  it('keeps the invitation when the project cannot be read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { contents, get } = createContents({});
    get.mockRejectedValue(new Error('server down'));
    const view = await render(
      contents,
      'project/chats/hubble.chat',
      () => warn.mock.calls.length > 0
    );
    try {
      expect(warn).toHaveBeenCalledWith(
        'Could not name the project of this session.',
        new Error('server down')
      );
      expect(view.node.querySelector(`.${CLASS}-project`)).toBeNull();
      expect(view.node.querySelector(`.${CLASS}-prompt`)).not.toBeNull();
    } finally {
      view.unmount();
      warn.mockRestore();
      contents.dispose();
    }
  });
});
