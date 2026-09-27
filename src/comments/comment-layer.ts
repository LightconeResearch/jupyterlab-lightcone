/**
 * What the overlay layers share: the classes they put on their host and on
 * their own node, the DOM helpers that spare mutations, the anchoring of a
 * layer in its host, and the flash that draws attention to a pin or badge.
 */

/** The CSS classes the layers add to the host and to their own nodes. */
export const COMMENT_HOST_CLASS = 'jp-jupyterlab-lightcone-CommentHost';
export const COMMENT_LAYER_CLASS = 'jp-jupyterlab-lightcone-CommentLayer';
const FLASH_CLASS = 'jp-jupyterlab-lightcone-CommentFlash';

/** How long a flashed pin or badge keeps its animation class, in ms. */
const FLASH_DURATION = 1600;

/** Marks a layer anchored at the scroll origin of a host that scrolls. */
const HOST_SCROLLS_ATTRIBUTE = 'data-host-scrolls';

/**
 * Whether a node is, or lies inside, a comment layer. Layers observe their
 * host's content; their own nodes and those of a sibling layer on the same
 * host are not content, and reacting to them would have two layers redraw
 * each other on every frame.
 */
export function inCommentLayer(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !!element?.closest(`.${COMMENT_LAYER_CLASS}`);
}

/** Set an element's text only when it differs, sparing a DOM mutation. */
export function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/** Set an attribute only when it differs, sparing a DOM mutation. */
export function setAttribute(
  element: HTMLElement,
  name: string,
  value: string
): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

/**
 * Keep a layer in its host and return the viewport point its children are
 * positioned from.
 *
 * Most hosts do not scroll themselves (a record tab or a Markdown preview
 * scrolls an inner element), so the layer covers the host's box and clips to
 * it. A host that scrolls its own content, like the image viewer, carries an
 * absolutely positioned child along with that content: the layer is then a
 * zero-size anchor at the scroll origin, and the host clips what it holds.
 * Measuring from the layer itself is right in both cases.
 */
export function anchorLayer(
  host: HTMLElement,
  layer: HTMLElement
): { left: number; top: number } {
  // React clears the host's children on its first render, taking the layer
  // with it; put it back beside the rendered content.
  if (layer.parentElement !== host) {
    host.appendChild(layer);
  }
  const style = window.getComputedStyle(host);
  const scrolls = /\b(auto|scroll)\b/.test(
    `${style.overflow} ${style.overflowX} ${style.overflowY}`
  );
  if (scrolls) {
    setAttribute(layer, HOST_SCROLLS_ATTRIBUTE, '');
  } else {
    layer.removeAttribute(HOST_SCROLLS_ATTRIBUTE);
  }
  const origin = layer.getBoundingClientRect();
  return { left: origin.left, top: origin.top };
}

/** Draw attention to a pin or badge for a moment. */
export function flashElement(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  element.classList.remove(FLASH_CLASS);
  // Restart the animation when the element is flashed twice in a row.
  void element.offsetWidth;
  element.classList.add(FLASH_CLASS);
  window.setTimeout(() => {
    element.classList.remove(FLASH_CLASS);
  }, FLASH_DURATION);
}
