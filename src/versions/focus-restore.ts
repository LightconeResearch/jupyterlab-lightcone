/**
 * Render a widget's content without losing keyboard focus.
 *
 * `render` starts the render and returns a promise that settles once it is
 * committed. When focus was inside `node` before the render and the render
 * removed the focused element (a followed link, or the Back button of a
 * record that is replaced), the browser leaves focus on the page body, where
 * no widget key binding matches. Focus then returns to `node` itself, which
 * must be focusable (a negative `tabIndex` suffices). Focus the reader moved
 * elsewhere meanwhile is left alone.
 */
export function renderKeepingFocus(
  node: HTMLElement,
  render: () => Promise<unknown> | undefined
): void {
  const document = node.ownerDocument;
  const focused = node.contains(document.activeElement);
  const rendered = render();
  if (!focused || !rendered) return;
  void rendered.then(() => {
    const active = document.activeElement;
    if (node.isConnected && (active === null || active === document.body))
      node.focus({ preventScroll: true });
  });
}
