import { PageConfig } from '@jupyterlab/coreutils';
import { AGENTS_OPTION, SERVER_OPTION } from '../server-features';

/** Which server install a suite runs as. */
export interface IServerInstall {
  /** Whether Jupyter AI chats run the agents: the `full` install. Default true. */
  chatAgents?: boolean;
}

/**
 * Run the enclosing suite as the full install does, with Lightcone's server
 * routes (and, unless `chatAgents` is false, Jupyter AI chats) announced in
 * the page configuration. Suites without it run as the default, browser-only
 * install; `{ chatAgents: false }` runs one as the `engine` install.
 */
export function withLightconeServer(options: IServerInstall = {}): void {
  const chatAgents = options.chatAgents ?? true;
  let previousServer = '';
  let previousAgents = '';
  beforeAll(() => {
    previousServer = PageConfig.getOption(SERVER_OPTION);
    previousAgents = PageConfig.getOption(AGENTS_OPTION);
    PageConfig.setOption(SERVER_OPTION, 'true');
    PageConfig.setOption(AGENTS_OPTION, chatAgents ? 'true' : '');
  });
  afterAll(() => {
    PageConfig.setOption(SERVER_OPTION, previousServer);
    PageConfig.setOption(AGENTS_OPTION, previousAgents);
  });
}
