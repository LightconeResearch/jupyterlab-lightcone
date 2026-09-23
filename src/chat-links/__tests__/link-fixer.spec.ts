import type { IChatPanel } from '@jupyter/chat';
import { Widget } from '@lumino/widgets';
import { attachChatLinks, type IChatLinkHost } from '../link-fixer';

const ROOT = '/srv/lab';
const BASE_URL = 'http://localhost:8888/lab/';

/** A chat panel with a real node, as Jupyter Chat's tracker hands it out. */
function chatPanel(name = 'project/chats/a.chat'): IChatPanel {
  const panel = Object.assign(new Widget(), { model: { name }, area: 'main' });
  Widget.attach(panel, document.body);
  return panel as unknown as IChatPanel;
}

function host(overrides: Partial<IChatLinkHost> = {}) {
  const open = jest.fn<Promise<void>, [string, IChatPanel]>(() =>
    Promise.resolve()
  );
  const baseDirectory = jest.fn<Promise<string>, [IChatPanel]>(() =>
    Promise.resolve('project')
  );
  return {
    open,
    baseDirectory,
    value: {
      serverRoots: [ROOT],
      baseUrl: BASE_URL,
      baseDirectory,
      open,
      ...overrides
    }
  };
}

/** A rendered chat message, as Jupyter Chat's Markdown renderer produces it. */
function message(html: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'jp-chat-rendered-message';
  node.innerHTML = html;
  return node;
}

/** Let mutation records, the base-directory lookup and the open settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Click `element` and report whether the chat claimed the click. An
 * unclaimed click reaches the link, where it is cancelled once observed:
 * the browser would navigate, which JSDOM cannot.
 */
function click(element: Element, init: MouseEventInit = {}): boolean {
  let atLink: boolean | undefined;
  const observe = (event: Event) => {
    atLink = event.defaultPrevented;
    event.preventDefault();
  };
  element.addEventListener('click', observe, { once: true });
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init
  });
  element.dispatchEvent(event);
  element.removeEventListener('click', observe);
  return atLink ?? event.defaultPrevented;
}

let panels: IChatPanel[] = [];

afterEach(() => {
  panels.forEach(panel => panel.dispose());
  panels = [];
});

function setup(overrides: Partial<IChatLinkHost> = {}) {
  const panel = chatPanel();
  panels.push(panel);
  const links = host(overrides);
  const attached = attachChatLinks(panel, links.value);
  return { panel, links, attached };
}

it('opens file links inside the server root and relative links in the project', async () => {
  const { panel, links } = setup();
  panel.node.appendChild(
    message(
      `<a id="abs" href="${ROOT}/project/x.md">x</a>` +
        '<a id="rel" href="results/a.png">a</a>'
    )
  );

  expect(click(panel.node.querySelector('#abs')!)).toBe(true);
  await settle();
  expect(links.open).toHaveBeenLastCalledWith('project/x.md', panel);

  expect(click(panel.node.querySelector('#rel')!)).toBe(true);
  await settle();
  expect(links.baseDirectory).toHaveBeenCalledWith(panel);
  expect(links.open).toHaveBeenLastCalledWith('project/results/a.png', panel);
});

it('leaves external, out-of-root, escaping and non-message links to the browser', async () => {
  const { panel, links } = setup();
  panel.node.appendChild(
    message(
      '<a id="ext" href="https://example.org">e</a>' +
        '<a id="etc" href="/etc/passwd">p</a>' +
        `<a id="up" href="${ROOT}/../etc/passwd">u</a>` +
        '<a id="frag" href="#top">t</a>' +
        `<a id="mid" href="${ROOT}/project/x.md">m</a>`
    )
  );
  const outside = document.createElement('a');
  outside.id = 'toolbar';
  outside.href = `${ROOT}/project/y.md`;
  panel.node.appendChild(outside);

  for (const id of ['ext', 'etc', 'up', 'frag', 'toolbar']) {
    expect(click(panel.node.querySelector(`#${id}`)!)).toBe(false);
  }
  // Only the primary button opens in JupyterLab.
  expect(click(panel.node.querySelector('#mid')!, { button: 1 })).toBe(false);
  await settle();
  expect(links.open).not.toHaveBeenCalled();
});

it('resolves relative links against the chat folder when the project is unknown', async () => {
  const { panel, links } = setup({
    baseDirectory: () => Promise.reject(new Error('offline'))
  });
  panel.node.appendChild(message('<a id="rel" href="x.md">x</a>'));
  click(panel.node.querySelector('#rel')!);
  await settle();
  expect(links.open).toHaveBeenCalledWith('project/chats/x.md', panel);
});

it('serves message images by path through the files route', async () => {
  const { panel } = setup();
  const rendered = message(
    `<img id="abs" src="${ROOT}/project/results/a b.png">` +
      '<img id="rel" src="results/c.png">' +
      '<img id="data" src="data:image/png;base64,AAAA">' +
      '<img id="etc" src="/etc/x.png">'
  );
  panel.node.appendChild(rendered);
  await settle();
  const source = (id: string) =>
    panel.node.querySelector(`#${id}`)!.getAttribute('src');
  expect(source('abs')).toBe(`${BASE_URL}files/project/results/a%20b.png`);
  expect(source('rel')).toBe(`${BASE_URL}files/project/results/c.png`);
  expect(source('data')).toBe('data:image/png;base64,AAAA');
  expect(source('etc')).toBe('/etc/x.png');

  // A re-rendered message changes the source in place.
  panel.node.querySelector('#rel')!.setAttribute('src', 'results/d.png');
  await settle();
  expect(source('rel')).toBe(`${BASE_URL}files/project/results/d.png`);
});

it('rewrites images already in the panel and leaves avatars alone', async () => {
  const panel = chatPanel();
  panels.push(panel);
  panel.node.appendChild(message('<img id="old" src="results/a.png">'));
  const avatar = document.createElement('img');
  avatar.setAttribute('src', 'avatar.png');
  panel.node.appendChild(avatar);
  attachChatLinks(panel, host().value);
  await settle();
  expect(panel.node.querySelector('#old')!.getAttribute('src')).toBe(
    `${BASE_URL}files/project/results/a.png`
  );
  expect(avatar.getAttribute('src')).toBe('avatar.png');
});

it('stops intercepting and rewriting once disposed', async () => {
  const { panel, links, attached } = setup();
  attached.dispose();
  expect(attached.isDisposed).toBe(true);
  panel.node.appendChild(
    message(
      `<a id="abs" href="${ROOT}/project/x.md">x</a>` +
        '<img id="img" src="results/a.png">'
    )
  );
  await settle();
  expect(panel.node.querySelector('#img')!.getAttribute('src')).toBe(
    'results/a.png'
  );
  expect(click(panel.node.querySelector('#abs')!)).toBe(false);
  await settle();
  expect(links.open).not.toHaveBeenCalled();
});
