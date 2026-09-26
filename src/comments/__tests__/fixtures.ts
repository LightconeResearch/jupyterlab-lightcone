import type { IComment, ICommentAnchor, ICommentTarget } from '../comments-api';
import { NULL_VERSION } from '../comment-model';

/** A pending comment on a record, with the given anchor. */
export function makeComment(
  id: string,
  anchor: ICommentAnchor,
  overrides: Partial<IComment> = {}
): IComment {
  return {
    id,
    created: '2026-09-23T10:00:00Z',
    updated: null,
    author: '',
    status: 'pending',
    sentWith: null,
    label: 1,
    text: `note ${id}`,
    target: recordTarget(),
    anchor,
    ...overrides
  };
}

/** The target of a comment on `outputs.hubble_diagram`. */
export function recordTarget(
  overrides: Partial<ICommentTarget> = {}
): ICommentTarget {
  return {
    kind: 'record',
    path: 'project/astra.yaml',
    record: 'outputs.hubble_diagram',
    universe: null,

    version: NULL_VERSION,
    ...overrides
  };
}

/** A layout rectangle, as jsdom cannot compute one. */
export function rect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}

/** Make an element report a fixed layout rectangle. */
export function placeAt(element: Element, box: DOMRect): void {
  element.getBoundingClientRect = () => box;
}

/**
 * Animation frames run on demand: the layers draw in frames, and tests step
 * through them to see what each one does and whether more are requested.
 */
export class Frames {
  install(): void {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      this._next += 1;
      this._queue.set(this._next, callback);
      return this._next;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      this._queue.delete(id);
    });
  }

  /** How many frames are waiting. */
  get pending(): number {
    return this._queue.size;
  }

  /**
   * Run the waiting frames, let mutation observers react, and repeat while
   * frames keep being requested, up to `rounds` times. Returns how many
   * rounds ran.
   */
  async flush(rounds = 20): Promise<number> {
    let ran = 0;
    while (this._queue.size && ran < rounds) {
      const callbacks = Array.from(this._queue.values());
      this._queue.clear();
      for (const callback of callbacks) {
        callback(performance.now());
      }
      ran += 1;
      await settle();
    }
    return ran;
  }

  private _queue = new Map<number, FrameRequestCallback>();
  private _next = 0;
}

/** Let pending promise callbacks and mutation observer records run. */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Wait, with real timers, until React and Lumino have caught up. */
export async function until(
  condition: () => boolean,
  timeout = 2000
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('The expected state was never reached.');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Type into a React-controlled field the way a browser would. */
export function typeInto(
  field: HTMLTextAreaElement | HTMLInputElement,
  value: string
): void {
  const prototype = Object.getPrototypeOf(field);
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A pointer event, which jsdom lacks, built on a mouse event. */
export function pointer(
  type: string,
  init: MouseEventInit & { pointerId?: number }
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  return event;
}

/** Give elements the pointer capture methods jsdom lacks. */
export function stubPointerCapture(): void {
  const captured = new WeakMap<Element, Set<number>>();
  const set = (element: Element) => {
    let ids = captured.get(element);
    if (!ids) {
      ids = new Set();
      captured.set(element, ids);
    }
    return ids;
  };
  Element.prototype.setPointerCapture = function (id: number) {
    set(this).add(id);
  };
  Element.prototype.releasePointerCapture = function (id: number) {
    set(this).delete(id);
  };
  Element.prototype.hasPointerCapture = function (id: number) {
    return set(this).has(id);
  };
}
