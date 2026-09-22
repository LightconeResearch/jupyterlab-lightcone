import { Clipboard } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentReadiness } from '../agent-readiness';
import { fetchAgentReadiness, type IAgentAdapter } from '../api';

jest.mock('../api', () => ({ fetchAgentReadiness: jest.fn() }));
const check = jest.mocked(fetchAgentReadiness);
const trans = nullTranslator.load('jupyterlab_lightcone');

// React only silences its act() warnings once the environment says it supports them.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => jest.resetAllMocks());

function adapter(
  id: string,
  name: string,
  installed: boolean,
  offered = true
): IAgentAdapter {
  return {
    id,
    name,
    persona: `${id}-acp`,
    executable: `${id}-acp`,
    install: `npm install -g ${id}`,
    login: `${id} login`,
    docs: `https://example.org/${id}`,
    installed,
    offered
  };
}

async function mount() {
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <AgentReadiness
        settings={ServerConnection.makeSettings()}
        trans={trans}
      />
    )
  );
  const button = (text: string) =>
    Array.from(node.querySelectorAll('button')).find(
      candidate => candidate.textContent === text
    );
  return {
    node,
    click: (text: string) =>
      act(async () => {
        button(text)?.click();
      })
  };
}

it('names each agent, its install command and what to do after installing', async () => {
  check.mockResolvedValue({
    npm: false,
    agents: [
      adapter('claude', 'Claude Code', true),
      adapter('codex', 'Codex', false)
    ]
  });
  const { node, click } = await mount();
  expect(node.textContent).toContain('Claude Coderead');
  expect(node.textContent).toContain('Codexnot installed');
  const commands = Array.from(node.querySelectorAll('code')).map(
    code => code.textContent
  );
  expect(commands).toEqual(['npm install -g codex']);
  expect(node.textContent).toContain('Sign in on the server with codex login.');
  expect(node.textContent).toContain('Node.js 22 or later');
  expect(node.textContent).toContain(
    'restart the Jupyter server or send /refresh-personas'
  );
  const copy = jest
    .spyOn(Clipboard, 'copyToSystem')
    .mockImplementation(() => undefined);
  await click('Copy');
  expect(copy).toHaveBeenCalledWith('npm install -g codex');
});

it('checks again on demand and explains a missing ACP client', async () => {
  check
    .mockResolvedValueOnce({
      npm: true,
      agents: [adapter('codex', 'Codex', false, false)]
    })
    .mockResolvedValueOnce({
      npm: true,
      agents: [adapter('codex', 'Codex', true)]
    });
  const { node, click } = await mount();
  expect(node.textContent).toContain(
    "Jupyter AI's ACP client is not installed"
  );
  await click('Check again');
  expect(check).toHaveBeenCalledTimes(2);
  expect(node.textContent).toContain('Codexready');
  expect(node.textContent).not.toContain('ACP client is not installed');
  expect(node.textContent).not.toContain('restart the Jupyter server');
});

it('reports a failed check and lets the user retry', async () => {
  check
    .mockRejectedValueOnce(new Error('Agent check request failed (503)'))
    .mockResolvedValueOnce({ npm: true, agents: [] });
  const { node, click } = await mount();
  expect(
    node.querySelector('.jp-jupyterlab-lightcone-TourAgents-error')?.textContent
  ).toBe('Agent check request failed (503)');
  await click('Check again');
  expect(
    node.querySelector('.jp-jupyterlab-lightcone-TourAgents-error')
  ).toBeNull();
});
