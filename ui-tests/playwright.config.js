/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  use: { ...baseConfig.use, baseURL: 'http://127.0.0.1:8888' },
  webServer: {
    command: 'jlpm start',
    url: 'http://127.0.0.1:8888/lab',
    timeout: 120 * 1000,
    reuseExistingServer: false
  }
};
