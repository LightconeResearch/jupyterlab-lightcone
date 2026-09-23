import { renderKeepingFocus } from '../focus-restore';

let node: HTMLDivElement;
let control: HTMLButtonElement;
let outside: HTMLInputElement;

beforeEach(() => {
  node = document.createElement('div');
  node.tabIndex = -1;
  control = document.createElement('button');
  node.appendChild(control);
  outside = document.createElement('input');
  document.body.append(node, outside);
});

afterEach(() => {
  node.remove();
  outside.remove();
});

/** A render that replaces the node's content once it settles. */
function replaceContent(): () => Promise<void> {
  return () =>
    Promise.resolve().then(() => {
      control.remove();
      node.appendChild(document.createElement('p'));
    });
}

test('focus returns to the widget when the render removes the focused control', async () => {
  control.focus();
  expect(document.activeElement).toBe(control);
  renderKeepingFocus(node, replaceContent());
  await Promise.resolve();
  await Promise.resolve();
  expect(document.activeElement).toBe(node);
});

test('focus that was elsewhere, or moved elsewhere meanwhile, is left alone', async () => {
  outside.focus();
  renderKeepingFocus(node, replaceContent());
  await Promise.resolve();
  await Promise.resolve();
  expect(document.activeElement).toBe(outside);

  node.appendChild(control);
  control.focus();
  renderKeepingFocus(node, () =>
    Promise.resolve().then(() => {
      outside.focus();
      control.remove();
    })
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(document.activeElement).toBe(outside);
});

test('a render that keeps the focused control leaves focus on it', async () => {
  control.focus();
  renderKeepingFocus(node, () => Promise.resolve());
  await Promise.resolve();
  await Promise.resolve();
  expect(document.activeElement).toBe(control);
  renderKeepingFocus(node, () => undefined);
  expect(document.activeElement).toBe(control);
});
