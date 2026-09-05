const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@astra-spec/sdk',
  '@codemirror',
  '@jupyter/',
  '@microsoft/',
  'exenv-es6',
  'yaml',
  '@jupyterlab/',
  'lib0',
  'nanoid',
  'vscode-ws-jsonrpc',
  'y-protocols',
  'y-websocket',
  'yjs'
].join('|');

const baseConfig = jestJupyterLab(__dirname);

module.exports = {
  ...baseConfig,
  automock: false,
  testEnvironment: '<rootDir>/jest-environment.js',
  modulePathIgnorePatterns: [
    '<rootDir>/.venv/',
    '<rootDir>/jupyterlab_lightcone/labextension/'
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/.ipynb_checkpoints/*'
  ],
  coverageReporters: ['lcov', 'text'],
  testRegex: 'src/.*/.*.spec.ts[x]?$',
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
