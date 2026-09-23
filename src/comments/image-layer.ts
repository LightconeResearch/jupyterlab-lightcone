import type { IDisposable } from '@lumino/disposable';
import type { IComment } from './comments-api';
import { clampPercent, labelGlyph } from './comment-model';
import { flashElement } from './editor-comments';

/** The CSS classes the layer adds to the host and to its own nodes. */
export const COMMENT_HOST_CLASS = 'jp-jupyterlab-lightcone-CommentHost';
export const COMMENT_LAYER_CLASS = 'jp-jupyterlab-lightcone-CommentLayer';
const FRAME_CLASS = 'jp-jupyterlab-lightcone-CommentFrame';
const PIN_CLASS = 'jp-jupyterlab-lightcone-CommentPin';
const DRAFT_CLASS = 'jp-jupyterlab-lightcone-CommentDraft';
const COMMENTABLE_CLASS = 'jp-jupyterlab-lightcone-Commentable';

/** Pointer travel below which a press counts as a click, in pixels. */
const CLICK_SLOP = 4;

export interface IImageLayerOptions {
  /** The widget node the layer covers; it becomes a positioned container. */
  host: HTMLElement;
  /** The images the layer overlays, found again after every change. */
  selectImages(): Iterable<HTMLImageElement>;
  /** A click on an image, as percentages across and down it. */
  onPoint(
    image: HTMLImageElement,
    x: number,
    y: number,
    event: MouseEvent
  ): void;
  /** A click on a pending comment's pin. */
  onPinClick(
    comment: IComment,
    element: HTMLElement,
    event: PointerEvent
  ): void;
  /** A pin was dragged to a new place. */
  onPinMoved(comment: IComment, x: number, y: number): void;
}

/**
 * Numbered, draggable pins over the images of a host widget, and a crosshair
 * click that starts a comment. The layer lives in its own node beside the
 * host's content, so React re-renders never touch it; it follows the images
 * by measuring them.
 */
export class ImageCommentLayer implements IDisposable {
  constructor(private options: IImageLayerOptions) {
    const { host } = options;
    host.classList.add(COMMENT_HOST_CLASS);
    this._layer = document.createElement('div');
    this._layer.className = COMMENT_LAYER_CLASS;
    host.appendChild(this._layer);
    host.addEventListener('pointerdown', this._pressed, true);
    host.addEventListener('click', this._clicked, true);
    host.addEventListener('scroll', this.schedule, true);
    this._resizes = new ResizeObserver(this.schedule);
    this._resizes.observe(host);
    this._mutations = new MutationObserver(records => {
      if (records.some(record => !this._layer.contains(record.target))) {
        this.schedule();
      }
    });
    this._mutations.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'class', 'width', 'height']
    });
    window.addEventListener('resize', this.schedule);
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Show these comments' point anchors as pins. */
  setComments(comments: readonly IComment[]): void {
    this._comments = comments.filter(
      comment =>
        comment.anchor.type === 'point' &&
        comment.anchor.x !== null &&
        comment.anchor.y !== null
    );
    this.schedule();
  }

  /** Show a dashed marker where a comment is being written, or clear it. */
  setDraft(image: HTMLImageElement | null, x = 0, y = 0): void {
    this._draft = image ? { image, x, y } : null;
    this.schedule();
  }

  /** Scroll a pin into view and flash it; remembered until the pin exists. */
  flash(id: string): void {
    this._flash = id;
    this.schedule();
  }

  /** Re-measure the images on the next frame. */
  schedule = (): void => {
    if (this._isDisposed || this._frame !== null) {
      return;
    }
    this._frame = window.requestAnimationFrame(() => {
      this._frame = null;
      this.render();
    });
  };

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    const { host } = this.options;
    if (this._frame !== null) {
      window.cancelAnimationFrame(this._frame);
    }
    host.removeEventListener('pointerdown', this._pressed, true);
    host.removeEventListener('click', this._clicked, true);
    host.removeEventListener('scroll', this.schedule, true);
    window.removeEventListener('resize', this.schedule);
    this._resizes.disconnect();
    this._mutations.disconnect();
    for (const image of this._images) {
      image.classList.remove(COMMENTABLE_CLASS);
    }
    this._layer.remove();
    host.classList.remove(COMMENT_HOST_CLASS);
  }

  private render(): void {
    const { host } = this.options;
    // React clears the host's children on its first render, taking the layer
    // with it; put it back beside the rendered content.
    if (!this._layer.isConnected) {
      host.appendChild(this._layer);
    }
    const images = Array.from(this.options.selectImages());
    const hostRect = host.getBoundingClientRect();
    const seen = new Set<HTMLImageElement>();
    for (const image of images) {
      seen.add(image);
      if (!this._images.has(image)) {
        this._images.add(image);
        image.classList.add(COMMENTABLE_CLASS);
        this._resizes.observe(image);
        image.addEventListener('load', this.schedule);
      }
      let frame = this._frames.get(image);
      if (!frame) {
        frame = document.createElement('div');
        frame.className = FRAME_CLASS;
        this._layer.appendChild(frame);
        this._frames.set(image, frame);
      }
      const rect = image.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      frame.hidden = !visible;
      if (!visible) {
        continue;
      }
      frame.style.left = `${rect.left - hostRect.left}px`;
      frame.style.top = `${rect.top - hostRect.top}px`;
      frame.style.width = `${rect.width}px`;
      frame.style.height = `${rect.height}px`;
      this.renderPins(image, frame);
    }
    for (const image of Array.from(this._images)) {
      if (seen.has(image)) {
        continue;
      }
      this._images.delete(image);
      image.classList.remove(COMMENTABLE_CLASS);
      image.removeEventListener('load', this.schedule);
      this._resizes.unobserve(image);
      this._frames.get(image)?.remove();
      this._frames.delete(image);
    }
  }

  private renderPins(image: HTMLImageElement, frame: HTMLElement): void {
    const live = new Set<string>();
    for (const comment of this._comments) {
      live.add(comment.id);
      let pin = this._pins.get(comment.id);
      if (!pin || pin.parentElement !== frame) {
        pin?.remove();
        pin = this.createPin(comment);
        frame.appendChild(pin);
        this._pins.set(comment.id, pin);
      }
      if (!this._dragging || this._dragging.id !== comment.id) {
        pin.style.left = `${comment.anchor.x}%`;
        pin.style.top = `${comment.anchor.y}%`;
      }
      pin.textContent = labelGlyph(comment.label);
      pin.title = comment.text;
      pin.setAttribute(
        'aria-label',
        `Comment ${comment.label}: ${comment.text}`
      );
      if (this._flash === comment.id) {
        this._flash = null;
        pin.scrollIntoView({ block: 'center', inline: 'center' });
        flashElement(pin);
      }
    }
    for (const [id, pin] of this._pins) {
      if (!live.has(id) && pin.parentElement === frame) {
        pin.remove();
        this._pins.delete(id);
      }
    }
    const draft = this._draft;
    if (draft && draft.image === image) {
      if (!this._draftNode) {
        this._draftNode = document.createElement('div');
        this._draftNode.className = DRAFT_CLASS;
        this._draftNode.setAttribute('aria-hidden', 'true');
      }
      if (this._draftNode.parentElement !== frame) {
        frame.appendChild(this._draftNode);
      }
      this._draftNode.style.left = `${draft.x}%`;
      this._draftNode.style.top = `${draft.y}%`;
    } else if (this._draftNode?.parentElement === frame && !draft) {
      this._draftNode.remove();
    }
  }

  private createPin(comment: IComment): HTMLElement {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = PIN_CLASS;
    pin.dataset.commentId = comment.id;
    pin.addEventListener('pointerdown', event => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pin.setPointerCapture(event.pointerId);
      this._dragging = {
        id: comment.id,
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        x: comment.anchor.x ?? 0,
        y: comment.anchor.y ?? 0
      };
    });
    pin.addEventListener('pointermove', event => {
      const drag = this._dragging;
      if (!drag || drag.pointer !== event.pointerId) {
        return;
      }
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <
          CLICK_SLOP
      ) {
        return;
      }
      drag.moved = true;
      const frame = pin.parentElement;
      if (!frame) {
        return;
      }
      const rect = frame.getBoundingClientRect();
      drag.x = clampPercent(((event.clientX - rect.left) / rect.width) * 100);
      drag.y = clampPercent(((event.clientY - rect.top) / rect.height) * 100);
      pin.style.left = `${drag.x}%`;
      pin.style.top = `${drag.y}%`;
    });
    const finish = (event: PointerEvent) => {
      const drag = this._dragging;
      if (!drag || drag.pointer !== event.pointerId) {
        return;
      }
      this._dragging = null;
      if (pin.hasPointerCapture(event.pointerId)) {
        pin.releasePointerCapture(event.pointerId);
      }
      if (event.type === 'pointercancel') {
        this.schedule();
        return;
      }
      const current = this._comments.find(item => item.id === comment.id);
      if (drag.moved) {
        if (current) {
          this.options.onPinMoved(current, drag.x, drag.y);
        }
      } else if (current) {
        this.options.onPinClick(current, pin, event);
      }
    };
    pin.addEventListener('pointerup', finish);
    pin.addEventListener('pointercancel', finish);
    pin.addEventListener('click', event => {
      // The pointer handlers already acted; keep the host from seeing a click.
      event.preventDefault();
      event.stopPropagation();
    });
    return pin;
  }

  private _pressed = (event: PointerEvent): void => {
    this._press = { x: event.clientX, y: event.clientY };
  };

  private _clicked = (event: MouseEvent): void => {
    const target = this._imageAt(event.target, event.clientX, event.clientY);
    if (
      !target ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const press = this._press;
    if (
      press &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP
    ) {
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.options.onPoint(
      target,
      clampPercent(((event.clientX - rect.left) / rect.width) * 100),
      clampPercent(((event.clientY - rect.top) / rect.height) * 100),
      event
    );
  };

  /**
   * The commentable image under a click. A zoomable figure gives its image
   * `pointer-events: none`, so the click lands on the wrapper; the image is
   * then the one the wrapper contains at that point.
   */
  private _imageAt(
    target: EventTarget | null,
    x: number,
    y: number
  ): HTMLImageElement | null {
    if (target instanceof HTMLImageElement) {
      return this._images.has(target) ? target : null;
    }
    if (!(target instanceof Element) || this._layer.contains(target)) {
      return null;
    }
    for (const image of this._images) {
      if (!target.contains(image)) {
        continue;
      }
      const rect = image.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return image;
      }
    }
    return null;
  }

  private _layer: HTMLElement;
  private _resizes: ResizeObserver;
  private _mutations: MutationObserver;
  private _images = new Set<HTMLImageElement>();
  private _frames = new Map<HTMLImageElement, HTMLElement>();
  private _pins = new Map<string, HTMLElement>();
  private _comments: readonly IComment[] = [];
  private _draft: { image: HTMLImageElement; x: number; y: number } | null =
    null;
  private _draftNode: HTMLElement | null = null;
  private _flash: string | null = null;
  private _frame: number | null = null;
  private _press: { x: number; y: number } | null = null;
  private _dragging: {
    id: string;
    pointer: number;
    startX: number;
    startY: number;
    moved: boolean;
    x: number;
    y: number;
  } | null = null;
  private _isDisposed = false;
}
