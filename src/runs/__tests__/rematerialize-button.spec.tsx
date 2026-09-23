import { CommandRegistry } from '@lumino/commands';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RematerializeButton } from '../rematerialize-button';
import { RunsCommandIDs } from '../runs-commands';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('RematerializeButton', () => {
  it('starts the stale outputs through the materialize command', async () => {
    const commands = new CommandRegistry();
    const execute = jest.fn(async () => undefined);
    commands.addCommand(RunsCommandIDs.materialize, { execute });
    act(() => {
      root.render(
        <RematerializeButton
          commands={commands}
          entrypoint="proj/astra.yaml"
          statuses={{
            'baseline/fit': { state: 'stale', detail: 'recipe changed' },
            'baseline/plot': { state: 'current', detail: '' }
          }}
        />
      );
    });
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Rematerialize stale (1)');
    await act(async () => {
      button.click();
    });
    expect(execute).toHaveBeenCalledWith({
      entrypoint: 'proj/astra.yaml',
      targets: ['baseline/fit'],
      refresh: false
    });
  });

  it('shows nothing when every output is current or runs are unavailable', () => {
    const commands = new CommandRegistry();
    act(() => {
      root.render(
        <RematerializeButton
          commands={commands}
          entrypoint="proj/astra.yaml"
          statuses={{ 'baseline/fit': { state: 'stale', detail: '' } }}
        />
      );
    });
    expect(container.querySelector('button')).toBeNull();
    const registration = commands.addCommand(RunsCommandIDs.materialize, {
      execute: () => undefined
    });
    act(() => {
      root.render(
        <RematerializeButton
          commands={commands}
          entrypoint="proj/astra.yaml"
          statuses={{ 'baseline/fit': { state: 'current', detail: '' } }}
        />
      );
    });
    expect(container.querySelector('button')).toBeNull();
    registration.dispose();
  });
});
