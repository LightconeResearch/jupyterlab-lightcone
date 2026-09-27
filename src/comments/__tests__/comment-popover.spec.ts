import { CommentPopover, type IPopoverRequest } from '../comment-popover';
import { typeInto, until } from './fixtures';

let popover: CommentPopover;

beforeEach(() => {
  popover = new CommentPopover();
});

afterEach(() => {
  popover.dispose();
});

function request(overrides: Partial<IPopoverRequest> = {}) {
  return {
    x: 5,
    y: 5,
    mode: 'compose' as const,
    onSave: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    onCancel: jest.fn(),
    ...overrides
  };
}

async function field(): Promise<HTMLTextAreaElement> {
  await until(() => !!popover.node.querySelector('textarea'));
  const node = popover.node.querySelector('textarea');
  if (!node) {
    throw new Error('No text field.');
  }
  return node;
}

function press(target: Element, key: string, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
  );
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(popover.node.querySelectorAll('button')).find(
    candidate => candidate.textContent === label
  );
  if (!found) {
    throw new Error(`No ${label} button.`);
  }
  return found;
}

describe('CommentPopover', () => {
  it('saves on Enter and stays open with the error when saving fails', async () => {
    const onSave = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('The server is away.'))
      .mockResolvedValueOnce(undefined);
    popover.open(request({ onSave }));
    const input = await field();
    typeInto(input, '  The legend covers the points.  ');
    await until(() => input.value.startsWith('  The legend'));
    press(input, 'Enter');
    await until(() => !!popover.node.querySelector('[role="alert"]'));
    expect(onSave).toHaveBeenCalledWith('The legend covers the points.');
    expect(popover.node.textContent).toContain('The server is away.');
    expect(popover.isOpen).toBe(true);
    press(await field(), 'Enter');
    await until(() => !popover.isOpen);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(popover.isAttached).toBe(false);
  });

  it('keeps composing on Shift+Enter and cancels on Escape', async () => {
    const pending = request();
    popover.open(pending);
    const input = await field();
    typeInto(input, 'note');
    press(input, 'Enter', true);
    expect(pending.onSave).not.toHaveBeenCalled();
    press(input, 'Escape');
    await until(() => !popover.isOpen);
    expect(pending.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a saved comment with Edit and Delete', async () => {
    const onDelete = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    popover.open(request({ mode: 'view', text: 'Saved note', onDelete }));
    await until(
      () => popover.node.textContent?.includes('Saved note') ?? false
    );
    button('Edit').click();
    const input = await field();
    expect(input.value).toBe('Saved note');
    popover.open(request({ mode: 'view', text: 'Saved note', onDelete }));
    await until(() => !popover.node.querySelector('textarea'));
    button('Delete').click();
    await until(() => !popover.isOpen);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('closes on a click elsewhere and when replaced', async () => {
    const first = request();
    popover.open(first);
    await field();
    const second = request();
    popover.open(second);
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    await field();
    popover.node.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true })
    );
    expect(popover.isOpen).toBe(true);
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true })
    );
    expect(popover.isOpen).toBe(false);
    expect(second.onCancel).toHaveBeenCalledTimes(1);
  });

  it('stays inside the window', () => {
    popover.open(request({ x: window.innerWidth + 100, y: -40 }));
    expect(popover.node.style.left).toBe(`${window.innerWidth - 320 - 8}px`);
    expect(popover.node.style.top).toBe('8px');
  });
});
