const JupyterEnvironment =
  require('@jupyterlab/testing/lib/jest-env.js').default;

/** Supply the browser API used by the SDK, absent from Jest 29's jsdom. */
module.exports = class extends JupyterEnvironment {
  async setup() {
    await super.setup();
    this.global.structuredClone = structuredClone;
    Object.defineProperty(this.global, 'crypto', {
      value: require('node:crypto').webcrypto
    });
  }
};
