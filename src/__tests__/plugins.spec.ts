import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { SERVER_OPTION } from '../server-features';

// The PDF runtime's worker URL uses `import.meta`, which Jest cannot parse.
jest.mock('../pdf-runtime', () => ({ loadPdfJs: jest.fn() }));

/** The extension's plugins, as JupyterLab loads them under a page option. */
function plugins(option: string): JupyterFrontEndPlugin<unknown>[] {
  let loaded: JupyterFrontEndPlugin<unknown>[] = [];
  // The isolated registry has its own page configuration to set.
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { PageConfig } = require('@jupyterlab/coreutils');
    PageConfig.setOption(SERVER_OPTION, option);
    loaded = require('../index').default;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return loaded;
}

/** The ids of the tokens a plugin cannot start without. */
function required(plugin: JupyterFrontEndPlugin<unknown>): string[] {
  return (plugin.requires ?? []).map(token => token.name);
}

const AGENT_PLUGINS = [
  'jupyterlab_lightcone:sessions',
  'jupyterlab_lightcone:session-placeholder',
  'jupyterlab_lightcone:agent-continuity',
  'jupyterlab_lightcone:chat-project',
  'jupyterlab_lightcone:chat',
  'jupyterlab_lightcone:chat-links',
  'jupyterlab_lightcone:mentions',
  'jupyterlab_lightcone:comments',
  'jupyterlab_lightcone:mystra'
];

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
  for (const id of AGENT_PLUGINS) {
    expect(ids).not.toContain(id);
  }
  // Nothing left waits for a token only Jupyter Chat or the agents provide.
  for (const plugin of plugins('')) {
    expect(
      required(plugin).filter(token => /chat|comment|session/i.test(token))
    ).toEqual([]);
  }
});

it('registers every plugin in the full install', () => {
  const ids = plugins('true').map(plugin => plugin.id);
  expect(ids).toEqual(expect.arrayContaining(AGENT_PLUGINS));
  expect(new Set(ids).size).toBe(ids.length);
});
