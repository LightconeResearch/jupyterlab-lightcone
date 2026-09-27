import { CommandRegistry } from '@lumino/commands';
import { FocusLayout, STATUS_BAR_TOGGLE } from '../focus-layout';

function setup(rightCollapsed: boolean, statusBar: boolean | null) {
  const shell = {
    rightCollapsed,
    collapseRight: jest.fn(() => {
      shell.rightCollapsed = true;
    }),
    expandRight: jest.fn(() => {
      shell.rightCollapsed = false;
    })
  };
  const commands = new CommandRegistry();
  const state = { statusBar: statusBar ?? false };
  if (statusBar !== null) {
    commands.addCommand(STATUS_BAR_TOGGLE, {
      isToggled: () => state.statusBar,
      execute: () => {
        state.statusBar = !state.statusBar;
      }
    });
  }
  return { shell, commands, state, layout: new FocusLayout(shell, commands) };
}

it('collapses the right area and hides the status bar, then restores both', async () => {
  const { shell, state, layout } = setup(false, true);
  await layout.toggle();
  expect(layout.active).toBe(true);
  expect(shell.rightCollapsed).toBe(true);
  expect(state.statusBar).toBe(false);
  await layout.toggle();
  expect(layout.active).toBe(false);
  expect(shell.rightCollapsed).toBe(false);
  expect(state.statusBar).toBe(true);
});

it('restores only what it changed', async () => {
  const { shell, state, layout } = setup(true, false);
  await layout.toggle();
  await layout.toggle();
  expect(shell.expandRight).not.toHaveBeenCalled();
  expect(shell.rightCollapsed).toBe(true);
  expect(state.statusBar).toBe(false);
});

it('works without a status bar plugin', async () => {
  const { shell, layout } = setup(false, null);
  await layout.toggle();
  expect(shell.rightCollapsed).toBe(true);
  await layout.toggle();
  expect(shell.rightCollapsed).toBe(false);
});
