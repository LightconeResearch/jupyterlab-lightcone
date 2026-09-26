import { SelectionCommentButton } from '../selection-button';
import { rect } from './fixtures';

const BUTTON = '.jp-jupyterlab-lightcone-CommentButton[data-floating]';

let realCreateRange: PropertyDescriptor | undefined;
let rangePrototype: Range;
let saved: Pick<Range, 'getClientRects' | 'getBoundingClientRect'>;

beforeAll(() => {
  // The JupyterLab test shim replaces ranges with inert stubs; selections
  // need real ones. jsdom has no layout, so every range ends at (200, 40).
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

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.useRealTimers();
});

/** Select `length` characters from `offset` in a text node. */
function select(node: Text, offset: number, length: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  jest.advanceTimersByTime(150);
}

function setup() {
  const root = document.createElement('div');
  root.innerHTML =
    '<p>Intro.</p><div data-page="4"><p>Alpha beta gamma</p></div>';
  const outside = document.createElement('p');
  outside.textContent = 'Elsewhere entirely';
  document.body.append(root, outside);
  const onComment = jest.fn();
  const button = new SelectionCommentButton<string>({
    resolve: node => (root.contains(node) ? { host: 'host', root } : null),
    onComment
  });
  const text = root.querySelector('[data-page] p')?.firstChild;
  if (!(text instanceof Text) || !(outside.firstChild instanceof Text)) {
    throw new Error('No text to select.');
  }
  return { root, outside: outside.firstChild, text, onComment, button };
}

function floating(): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(BUTTON);
  if (!node) {
    throw new Error('The Comment button is missing.');
  }
  return node;
}

describe('SelectionCommentButton', () => {
  it('captures the quote, the text before it and the page', () => {
    const { text, onComment, button } = setup();
    select(text, 'Alpha '.length, 'beta'.length);
    const node = floating();
    expect(node.hidden).toBe(false);
    expect(node.style.left).toBe('206px');
    expect(node.style.top).toBe('46px');
    node.click();
    expect(onComment).toHaveBeenCalledWith({
      host: 'host',
      root: expect.any(HTMLElement),
      quote: 'beta',
      prefix: 'Intro.Alpha ',
      page: 4,
      x: 206,
      y: 46
    });
    expect(node.hidden).toBe(true);
    button.dispose();
  });

  it('stays hidden outside commentable views and for empty selections', () => {
    const { outside, text, button } = setup();
    select(outside, 0, 'Elsewhere'.length);
    expect(floating().hidden).toBe(true);
    select(text, 0, 0);
    expect(floating().hidden).toBe(true);
    select(text, 0, 'Alpha'.length);
    expect(floating().hidden).toBe(false);
    document.dispatchEvent(new Event('scroll'));
    expect(floating().hidden).toBe(true);
    button.dispose();
    expect(document.querySelector(BUTTON)).toBeNull();
  });
});
