const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@astra-spec/',
  '@codemirror',
  '@marijn',
  '@microsoft',
  '@jupyter-ai/',
  '@jupyter/chat',
  '@jupyter/react-components',
  '@jupyter/web-components',
  '@jupyter/ydoc',
  '@jupyterlab/',
  'color',
  'exenv-es6',
  'lib0',
  'marked',
  'nanoid',
  'vscode-ws-jsonrpc',
  'y-protocols',
  'y-websocket',
  'yaml',
  'yjs'
].join('|');

const baseConfig = jestJupyterLab(__dirname);

module.exports = {
  ...baseConfig,
  automock: false,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/.ipynb_checkpoints/*'
  ],
  coverageReporters: ['lcov', 'text'],
  testRegex: 'src/.*/.*.spec.ts[x]?$',
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
