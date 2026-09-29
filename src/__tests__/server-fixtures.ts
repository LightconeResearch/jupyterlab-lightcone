import { PageConfig } from '@jupyterlab/coreutils';
import { SERVER_OPTION } from '../server-features';

/**
 * Run the enclosing suite as the full install does, with Lightcone's server
 * routes announced in the page configuration. Suites without it run as the
 * default, browser-only install.
 */
export function withLightconeServer(): void {
  let previous = '';
  beforeAll(() => {
    previous = PageConfig.getOption(SERVER_OPTION);
    PageConfig.setOption(SERVER_OPTION, 'true');
  });
  afterAll(() => {
    PageConfig.setOption(SERVER_OPTION, previous);
  });
}
