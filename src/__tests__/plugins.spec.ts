import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { AGENTS_OPTION, SERVER_OPTION } from '../server-features';

// The PDF runtime's worker URL uses `import.meta`, which Jest cannot parse.
jest.mock('../pdf-runtime', () => ({ loadPdfJs: jest.fn() }));

/** The extension's plugins, as JupyterLab loads them under the page options. */
function plugins(
  server: string,
  agents: string = server
): JupyterFrontEndPlugin<unknown>[] {
  let loaded: JupyterFrontEndPlugin<unknown>[] = [];
  // The isolated registry has its own page configuration to set.
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { PageConfig } = require('@jupyterlab/coreutils');
    PageConfig.setOption(SERVER_OPTION, server);
    PageConfig.setOption(AGENTS_OPTION, agents);
    loaded = require('../index').default;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return loaded;
}

/** The ids of the tokens a plugin cannot start without. */
function required(plugin: JupyterFrontEndPlugin<unknown>): string[] {
  return (plugin.requires ?? []).map(token => token.name);
}

const CHAT_PLUGINS = [
  'jupyterlab_lightcone:sessions',
  'jupyterlab_lightcone:session-placeholder',
  'jupyterlab_lightcone:agent-continuity',
  'jupyterlab_lightcone:chat-project',
  'jupyterlab_lightcone:chat',
  'jupyterlab_lightcone:chat-links',
  'jupyterlab_lightcone:mentions',
  'jupyterlab_lightcone:comments'
];

const SERVER_PLUGINS = [...CHAT_PLUGINS, 'jupyterlab_lightcone:mystra'];

/** Whether a plugin cannot start without a token only Jupyter Chat or the agents provide. */
function needsChat(plugin: JupyterFrontEndPlugin<unknown>): boolean {
  return required(plugin).some(token => /chat|comment|session/i.test(token));
}

it('leaves the plugins built on the server routes out of the browser-only install', () => {
  const ids = plugins('').map(plugin => plugin.id);
  expect(ids).toEqual(
    expect.arrayContaining([
      'jupyterlab_lightcone:plugin',
      'jupyterlab-lightcone:home',
      'jupyterlab-lightcone:search',
      'jupyterlab_lightcone:versions'
    ])
  );
  for (const id of SERVER_PLUGINS) {
    expect(ids).not.toContain(id);
  }
  // Nothing left waits for a token only Jupyter Chat or the agents provide.
  expect(plugins('').filter(needsChat)).toEqual([]);
});

it('leaves the chat plugins out of the engine install, without Jupyter AI', () => {
  const loaded = plugins('true', '');
  const ids = loaded.map(plugin => plugin.id);
  expect(ids).toContain('jupyterlab_lightcone:mystra');
  for (const id of CHAT_PLUGINS) {
    expect(ids).not.toContain(id);
  }
  expect(loaded.filter(needsChat)).toEqual([]);
});

it('registers every plugin in the ai install', () => {
  const ids = plugins('true').map(plugin => plugin.id);
  expect(ids).toEqual(expect.arrayContaining(SERVER_PLUGINS));
  expect(new Set(ids).size).toBe(ids.length);
});
