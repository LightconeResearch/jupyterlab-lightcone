/** Events by which the reader takes over a body being scrolled back. */
const INTERACTIONS = ['wheel', 'pointerdown', 'keydown', 'touchstart'];

/**
 * Scroll `element` to `target`, and apply the offset again as the element's
 * content grows until it is reached: a record body keeps growing while its
 * figure and provenance load, and the browser clamps an offset beyond it.
 * Scrolls made meanwhile by other code, such as focus landing in the body,
 * are corrected too; an interaction by the reader ends the wait. Returns a
 * function that ends it too.
 */
export function restoreScrollOffset(
  element: HTMLElement,
  target: number
): () => void {
  element.scrollTop = target;
  if (element.scrollTop >= target || typeof ResizeObserver === 'undefined') {
    return () => undefined;
  }
  const observer = new ResizeObserver(() => {
    element.scrollTop = target;
    if (element.scrollTop >= target) stop();
  });
  function stop(): void {
    observer.disconnect();
    for (const type of INTERACTIONS) {
      element.removeEventListener(type, stop, true);
    }
  }
  for (const type of INTERACTIONS) {
    element.addEventListener(type, stop, true);
  }
  for (const child of Array.from(element.children)) {
    observer.observe(child);
  }
  return stop;
}
