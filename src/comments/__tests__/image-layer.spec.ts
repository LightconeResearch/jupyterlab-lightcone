import {
  COMMENT_HOST_CLASS,
  COMMENT_LAYER_CLASS,
  inCommentLayer
} from '../comment-layer';
import { emptyAnchor, pointAnchor } from '../comment-model';
import { ImageCommentLayer, type IImageLayerOptions } from '../image-layer';
import {
  Frames,
  makeComment,
  placeAt,
  pointer,
  rect,
  stubPointerCapture
} from './fixtures';

const PIN = '.jp-jupyterlab-lightcone-CommentPin';
const FRAME = '.jp-jupyterlab-lightcone-CommentFrame';
const DRAFT = '.jp-jupyterlab-lightcone-CommentDraft';

let frames: Frames;

beforeAll(() => {
  stubPointerCapture();
});

beforeEach(() => {
  frames = new Frames();
  frames.install();
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A host holding one 200×100 image at (100, 50), with a layer over it. */
function setup() {
  const host = document.createElement('div');
  const image = document.createElement('img');
  host.appendChild(image);
  document.body.appendChild(host);
  placeAt(host, rect(0, 0, 400, 300));
  placeAt(image, rect(100, 50, 200, 100));
  const options = {
    host,
    selectImages: () => [image],
    onPoint: jest.fn<void, Parameters<IImageLayerOptions['onPoint']>>(),
    onPinClick: jest.fn<void, Parameters<IImageLayerOptions['onPinClick']>>(),
    onPinMoved: jest.fn<void, Parameters<IImageLayerOptions['onPinMoved']>>()
  };
  const layer = new ImageCommentLayer(options);
  const node = host.querySelector<HTMLElement>(`.${COMMENT_LAYER_CLASS}`);
  if (!node) {
    throw new Error('The layer was not added to its host.');
  }
  placeAt(node, rect(0, 0, 400, 300));
  return { host, image, layer, node, options };
}

describe('ImageCommentLayer', () => {
  it('turns a click on an image into percentages across and down it', async () => {
    const { image, layer, options } = setup();
    // A real ResizeObserver reports the host once when observed; the test
    // shim never does, so ask for the first measurement.
    layer.schedule();
    await frames.flush();
    image.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 75 }));
    image.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 75
      })
    );
    expect(options.onPoint).toHaveBeenCalledWith(
      image,
      25,
      25,
      expect.any(MouseEvent)
    );
    options.onPoint.mockClear();
    image.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        clientX: 150,
        clientY: 75,
        ctrlKey: true
      })
    );
    // A press that travelled is a drag or a selection, not a click.
    image.dispatchEvent(pointer('pointerdown', { clientX: 120, clientY: 75 }));
    image.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 75 })
    );
    expect(options.onPoint).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('draws numbered pins for point comments only', async () => {
    const { host, layer } = setup();
    layer.setComments([
      makeComment('a', pointAnchor(42.4, 31), { label: 2 }),
      makeComment('b', { ...emptyAnchor('text'), quote: 'text' })
    ]);
    await frames.flush();
    const frame = host.querySelector<HTMLElement>(FRAME);
    expect(frame?.style.left).toBe('100px');
    expect(frame?.style.top).toBe('50px');
    const pins = host.querySelectorAll<HTMLElement>(PIN);
    expect(pins).toHaveLength(1);
    expect(pins[0].dataset.commentId).toBe('a');
    expect(pins[0].style.left).toBe('42.4%');
    expect(pins[0].style.top).toBe('31%');
    expect(pins[0].textContent).toBe('②');
    expect(pins[0].getAttribute('aria-label')).toBe('Comment 2: note a');
    layer.setComments([]);
    await frames.flush();
    expect(host.querySelectorAll(PIN)).toHaveLength(0);
    layer.dispose();
  });

  it('reports a dragged pin and keeps it where it was dropped', async () => {
    const { host, layer, options } = setup();
    const comment = makeComment('a', pointAnchor(10, 20));
    layer.setComments([comment]);
    await frames.flush();
    const pin = host.querySelector<HTMLElement>(PIN);
    const frame = host.querySelector<HTMLElement>(FRAME);
    if (!pin || !frame) {
      throw new Error('No pin was drawn.');
    }
    placeAt(frame, rect(100, 50, 200, 100));
    pin.dispatchEvent(pointer('pointerdown', { clientX: 120, clientY: 70 }));
    pin.dispatchEvent(pointer('pointermove', { clientX: 170, clientY: 100 }));
    pin.dispatchEvent(pointer('pointerup', { clientX: 170, clientY: 100 }));
    expect(options.onPinMoved).toHaveBeenCalledWith(comment, 35, 50);
    expect(options.onPinClick).not.toHaveBeenCalled();
    // A redraw while the move is being saved leaves the pin where it was put.
    layer.schedule();
    await frames.flush();
    expect(pin.style.left).toBe('35%');
    expect(pin.style.top).toBe('50%');
    // The stored comments win once they come back, even unchanged.
    layer.setComments([comment]);
    await frames.flush();
    expect(pin.style.left).toBe('10%');
    layer.dispose();
  });

  it('treats a press without travel on a pin as a click', async () => {
    const { host, layer, options } = setup();
    const comment = makeComment('a', pointAnchor(10, 20));
    layer.setComments([comment]);
    await frames.flush();
    const pin = host.querySelector<HTMLElement>(PIN);
    if (!pin) {
      throw new Error('No pin was drawn.');
    }
    pin.dispatchEvent(pointer('pointerdown', { clientX: 120, clientY: 70 }));
    pin.dispatchEvent(pointer('pointermove', { clientX: 121, clientY: 71 }));
    pin.dispatchEvent(pointer('pointerup', { clientX: 121, clientY: 71 }));
    expect(options.onPinClick).toHaveBeenCalledWith(
      comment,
      pin,
      expect.any(MouseEvent)
    );
    expect(options.onPinMoved).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('opens a pin from the keyboard but not twice from a pointer', async () => {
    const { host, layer, options } = setup();
    const comment = makeComment('a', pointAnchor(10, 20));
    layer.setComments([comment]);
    await frames.flush();
    const pin = host.querySelector<HTMLElement>(PIN);
    if (!pin) {
      throw new Error('No pin was drawn.');
    }
    // Enter or Space on a focused button fires a click with no pointer.
    pin.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })
    );
    expect(options.onPinClick).toHaveBeenCalledTimes(1);
    expect(options.onPinClick).toHaveBeenLastCalledWith(
      comment,
      pin,
      expect.any(MouseEvent)
    );
    // A pointer click acts on pointerup; its click event must not repeat it.
    pin.dispatchEvent(pointer('pointerdown', { clientX: 120, clientY: 70 }));
    pin.dispatchEvent(pointer('pointerup', { clientX: 120, clientY: 70 }));
    pin.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    );
    expect(options.onPinClick).toHaveBeenCalledTimes(2);
    layer.dispose();
  });

  it('shows and clears the draft marker', async () => {
    const { host, image, layer } = setup();
    layer.setDraft(image, 10, 20);
    await frames.flush();
    const draft = host.querySelector<HTMLElement>(DRAFT);
    expect(draft?.style.left).toBe('10%');
    expect(draft?.style.top).toBe('20%');
    layer.setDraft(null);
    await frames.flush();
    expect(host.querySelector(DRAFT)).toBeNull();
    layer.dispose();
  });

  it('follows the content of a host that scrolls itself', async () => {
    const { host, layer, node } = setup();
    // The image viewer scrolls its own content, which carries the layer: the
    // layer's origin moves up by the scroll offset while the image moves
    // with it.
    host.style.overflow = 'auto';
    placeAt(node, rect(0, -500, 0, 0));
    layer.setComments([makeComment('a', pointAnchor(50, 50))]);
    await frames.flush();
    expect(node.hasAttribute('data-host-scrolls')).toBe(true);
    const frame = host.querySelector<HTMLElement>(FRAME);
    expect(frame?.style.top).toBe('550px');
    expect(frame?.style.left).toBe('100px');
    host.style.overflow = '';
    placeAt(node, rect(0, 0, 400, 300));
    layer.schedule();
    await frames.flush();
    expect(node.hasAttribute('data-host-scrolls')).toBe(false);
    expect(frame?.style.top).toBe('50px');
    layer.dispose();
  });

  it('puts its layer back when the host content is replaced', async () => {
    const { host, node, layer } = setup();
    host.replaceChildren(
      host.querySelector('img') ?? document.createElement('img')
    );
    layer.schedule();
    await frames.flush();
    expect(node.parentElement).toBe(host);
    layer.dispose();
    expect(node.isConnected).toBe(false);
    expect(host.classList.contains(COMMENT_HOST_CLASS)).toBe(false);
  });

  it('stops listening to retained images when disposed', async () => {
    const { image, layer } = setup();
    const schedule = jest.spyOn(layer, 'schedule');
    layer.schedule();
    await frames.flush();
    schedule.mockClear();
    image.dispatchEvent(new Event('load'));
    expect(schedule).toHaveBeenCalledTimes(1);
    layer.dispose();
    schedule.mockClear();
    // A document may keep its image after the comments plugin is disposed.
    image.dispatchEvent(new Event('load'));
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('inCommentLayer', () => {
  it('recognizes layer nodes and their text', () => {
    const layer = document.createElement('div');
    layer.className = COMMENT_LAYER_CLASS;
    const pin = document.createElement('button');
    pin.textContent = '①';
    layer.appendChild(pin);
    const outside = document.createElement('p');
    outside.textContent = 'content';
    document.body.append(layer, outside);
    expect(inCommentLayer(layer)).toBe(true);
    expect(inCommentLayer(pin)).toBe(true);
    expect(inCommentLayer(pin.firstChild ?? pin)).toBe(true);
    expect(inCommentLayer(outside)).toBe(false);
    expect(inCommentLayer(outside.firstChild ?? outside)).toBe(false);
  });
});
