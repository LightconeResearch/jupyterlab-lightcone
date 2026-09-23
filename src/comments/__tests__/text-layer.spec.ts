import { emptyAnchor, pointAnchor } from '../comment-model';
import type { ICommentAnchor } from '../comments-api';
import { COMMENT_LAYER_CLASS, ImageCommentLayer } from '../image-layer';
import * as textAnchor from '../text-anchor';
import { indexText, rangeForSpan, TextCommentLayer } from '../text-layer';
import { Frames, makeComment, placeAt, rect } from './fixtures';

const BADGE = '.jp-jupyterlab-lightcone-CommentBadge';
const HIGHLIGHT = '.jp-jupyterlab-lightcone-CommentHighlight';

/** Where each text node's range is drawn, as jsdom has no layout. */
const lineBoxes = new WeakMap<Node, DOMRect>();

let realCreateRange: PropertyDescriptor | undefined;
let rangePrototype: Range;
let savedClientRects: Range['getClientRects'];
let frames: Frames;

beforeAll(() => {
  // The JupyterLab test shim replaces ranges with inert stubs; the layer
  // needs real ones, drawn where the test says their text is.
  realCreateRange = Object.getOwnPropertyDescriptor(document, 'createRange');
  Reflect.deleteProperty(document, 'createRange');
  rangePrototype = Object.getPrototypeOf(document.createRange());
  savedClientRects = rangePrototype.getClientRects;
  rangePrototype.getClientRects = function (this: Range) {
    const box = lineBoxes.get(this.startContainer);
    const boxes = box ? [box] : [];
    return Object.assign(boxes, {
      item: (index: number) => boxes[index] ?? null
    }) as unknown as DOMRectList;
  };
  Element.prototype.scrollIntoView = jest.fn();
});

afterAll(() => {
  rangePrototype.getClientRects = savedClientRects;
  if (realCreateRange) {
    Object.defineProperty(document, 'createRange', realCreateRange);
  }
});

beforeEach(() => {
  frames = new Frames();
  frames.install();
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A text anchor, or a PDF one on `page`. */
function quoteAnchor(
  quote: string,
  page: number | null = null
): ICommentAnchor {
  return {
    ...emptyAnchor(page === null ? 'text' : 'pdf'),
    quote,
    page
  };
}

/** The first text node under a selector. */
function textIn(root: ParentNode, selector: string): Text {
  const node = root.querySelector(selector)?.firstChild;
  if (!(node instanceof Text)) {
    throw new Error(`No text in ${selector}.`);
  }
  return node;
}

describe('indexText and rangeForSpan', () => {
  it('maps offsets of the laid-out text back to its nodes', () => {
    const root = document.createElement('p');
    root.innerHTML = 'The <em>magnitude</em> offset';
    const index = indexText(root, () => false);
    expect(index.text).toBe('The magnitude offset');
    expect(index.nodes.map(entry => entry.start)).toEqual([0, 4, 13]);
    const span = textAnchor.findQuote(index.text, 'magnitude offset', null);
    if (!span) {
      throw new Error('The quote was not found.');
    }
    const range = rangeForSpan(index, span);
    expect(range?.toString()).toBe('magnitude offset');
    expect(range?.startContainer).toBe(textIn(root, 'em'));
    expect(range?.startOffset).toBe(0);
  });

  it('ends a span on a node boundary inside the node it covers', () => {
    const root = document.createElement('p');
    root.innerHTML = 'The <em>magnitude</em> offset';
    const index = indexText(root, () => false);
    const em = textIn(root, 'em');
    const range = rangeForSpan(index, { from: 4, to: 13 });
    expect(range?.endContainer).toBe(em);
    expect(range?.endOffset).toBe(em.length);
    const across = rangeForSpan(index, { from: 2, to: 6 });
    expect(across?.startContainer).toBe(root.firstChild);
    expect(across?.startOffset).toBe(2);
    expect(across?.endContainer).toBe(em);
    expect(across?.endOffset).toBe(2);
  });

  it('leaves out skipped nodes', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>kept</p><script>dropped</script>';
    const index = indexText(
      root,
      node => !!node.parentElement?.closest('script')
    );
    expect(index.text).toBe('kept');
  });
});

describe('TextCommentLayer', () => {
  function setup() {
    const host = document.createElement('div');
    host.innerHTML =
      '<div data-page="2"><p class="two">magnitude offset</p></div>' +
      '<div data-page="3"><p class="three">magnitude offset</p></div>';
    document.body.appendChild(host);
    placeAt(host, rect(0, 0, 400, 300));
    lineBoxes.set(textIn(host, '.two'), rect(40, 60, 90, 14));
    lineBoxes.set(textIn(host, '.three'), rect(40, 160, 90, 14));
    const onBadgeClick = jest.fn();
    const layer = new TextCommentLayer({ host, onBadgeClick });
    const node = host.querySelector<HTMLElement>(`.${COMMENT_LAYER_CLASS}`);
    if (!node) {
      throw new Error('The layer was not added to its host.');
    }
    placeAt(node, rect(10, 20, 400, 300));
    return { host, layer, node, onBadgeClick };
  }

  it('marks the first occurrence of a quote, measured from the layer', async () => {
    const { host, layer } = setup();
    layer.setComments([
      makeComment('a', quoteAnchor('magnitude offset'), { label: 3 }),
      makeComment('b', pointAnchor(10, 10)),
      makeComment('c', quoteAnchor(''))
    ]);
    await frames.flush();
    const badges = host.querySelectorAll<HTMLElement>(BADGE);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('③');
    expect(badges[0].dataset.commentId).toBe('a');
    expect(badges[0].style.left).toBe('30px');
    expect(badges[0].style.top).toBe('40px');
    const highlight = host.querySelector<HTMLElement>(HIGHLIGHT);
    expect(highlight?.style.width).toBe('90px');
    expect(highlight?.style.height).toBe('14px');
    layer.dispose();
  });

  it('searches a paper comment on its own page', async () => {
    const { host, layer } = setup();
    layer.setComments([makeComment('a', quoteAnchor('magnitude offset', 3))]);
    await frames.flush();
    const badge = host.querySelector<HTMLElement>(BADGE);
    expect(badge?.style.top).toBe('140px');
    layer.dispose();
  });

  it('opens a comment from its badge and flashes it on request', async () => {
    const { host, layer, onBadgeClick } = setup();
    const comment = makeComment('a', quoteAnchor('magnitude offset'));
    layer.setComments([comment]);
    layer.flash('a');
    await frames.flush();
    const badge = host.querySelector<HTMLElement>(BADGE);
    if (!badge) {
      throw new Error('No badge was drawn.');
    }
    expect(badge.classList).toContain('jp-jupyterlab-lightcone-CommentFlash');
    badge.click();
    expect(onBadgeClick).toHaveBeenCalledWith(
      comment,
      badge,
      expect.any(MouseEvent)
    );
    layer.setComments([]);
    await frames.flush();
    expect(host.querySelector(BADGE)).toBeNull();
    expect(host.querySelector(HIGHLIGHT)).toBeNull();
    layer.dispose();
  });

  it('normalizes a text once for all its comments', async () => {
    const { host, layer } = setup();
    const normalize = jest.spyOn(textAnchor, 'normalizeForSearch');
    layer.setComments([
      makeComment('a', quoteAnchor('magnitude')),
      makeComment('b', quoteAnchor('offset')),
      makeComment('c', quoteAnchor('magnitude offset'))
    ]);
    await frames.flush();
    // The host's text is its two paragraphs; the quotes are shorter.
    const whole = 'magnitude offset'.repeat(2);
    expect(normalize.mock.calls.filter(([raw]) => raw === whole)).toHaveLength(
      1
    );
    expect(host.querySelectorAll(BADGE)).toHaveLength(3);
    layer.dispose();
  });

  it('does not search texts beyond the search limit', async () => {
    const { host, layer } = setup();
    const filler = document.createElement('p');
    filler.textContent = 'x'.repeat(textAnchor.SEARCH_LIMIT);
    host.appendChild(filler);
    const normalize = jest.spyOn(textAnchor, 'normalizeForSearch');
    layer.setComments([makeComment('a', quoteAnchor('magnitude offset'))]);
    await frames.flush();
    expect(host.querySelector(BADGE)).toBeNull();
    expect(
      normalize.mock.calls.some(([raw]) => raw.length > textAnchor.SEARCH_LIMIT)
    ).toBe(false);
    layer.dispose();
  });
});

describe('two layers on one host', () => {
  it('stop redrawing once both have drawn', async () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<img class="figure"><p class="caption">The magnitude offset is profiled.</p>';
    document.body.appendChild(host);
    placeAt(host, rect(0, 0, 400, 300));
    const image = host.querySelector<HTMLImageElement>('img.figure');
    if (!image) {
      throw new Error('No image.');
    }
    placeAt(image, rect(0, 0, 200, 100));
    lineBoxes.set(textIn(host, '.caption'), rect(0, 120, 180, 14));
    const images = new ImageCommentLayer({
      host,
      selectImages: () => [image],
      onPoint: jest.fn(),
      onPinClick: jest.fn(),
      onPinMoved: jest.fn()
    });
    const texts = new TextCommentLayer({ host, onBadgeClick: jest.fn() });
    images.setComments([makeComment('a', pointAnchor(10, 10))]);
    texts.setComments([makeComment('b', quoteAnchor('magnitude offset'))]);
    const rounds = await frames.flush(30);
    expect(
      host.querySelectorAll('.jp-jupyterlab-lightcone-CommentPin')
    ).toHaveLength(1);
    expect(host.querySelectorAll(BADGE)).toHaveLength(1);
    expect(frames.pending).toBe(0);
    expect(rounds).toBeLessThan(5);
    images.dispose();
    texts.dispose();
  });
});
