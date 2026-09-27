import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';
import { ElementWidget } from '../../element-widget';
import { ElementHistoryCommandIDs } from '../element-history';
import { FakeThemeManager } from './theme-fixtures';
import { requestAPI } from '../../request';
import { until } from '../../__tests__/async-fixtures';
import { createContents, fileModel } from '../../__tests__/project-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const SPEC = `version: "0.0.14"
name: Trail project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
decisions:
  model:
    label: Cosmological model
    options:
      lcdm:
        label: LCDM
    default: lcdm
`;

beforeEach(() => {
  jest.mocked(requestAPI).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return { outputs: {} };
    }
    throw new Error(`Not served in this test: ${endpoint}`);
  });
});

function reference(target: string) {
  return { entrypoint: ENTRYPOINT, target, universeId: null };
}

test('the tab history trail marks each record with its kind', async () => {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(SPEC) });
  // The tab tells its Back and Forward commands when the history moves.
  const commands = new CommandRegistry();
  for (const id of [
    ElementHistoryCommandIDs.back,
    ElementHistoryCommandIDs.forward
  ]) {
    commands.addCommand(id, { execute: () => undefined });
  }
  const widget = new ElementWidget(
    reference('inputs.catalog'),
    contents,
    new FakeThemeManager(),
    commands,
    { openOrReveal: () => undefined },
    JSON.stringify([ENTRYPOINT, 'inputs.catalog', null]),
    'lightcone-element-trail'
  );
  try {
    for (const [target, label] of [
      ['inputs.catalog', 'Catalog'],
      ['decisions.model', 'Cosmological model'],
      ['outputs.hubble_diagram', 'Hubble diagram']
    ]) {
      widget.display(
        reference(target),
        JSON.stringify([ENTRYPOINT, target, null]),
        label
      );
    }
    Widget.attach(widget, document.body);
    const crumbs = () =>
      Array.from(
        widget.node.querySelectorAll(
          '.jp-jupyterlab-lightcone-element-trail > :is(button, span[aria-current])'
        )
      );
    await until(() => crumbs().length === 3);
    expect(
      crumbs().map(crumb => [
        crumb.textContent,
        crumb
          .querySelector('.lightcone-brand.astra-ui > .astra-kind-glyph')
          ?.getAttribute('data-kind')
      ])
    ).toEqual([
      ['▤inputs.catalog', 'input'],
      ['◇decisions.model', 'decision'],
      ['◆outputs.hubble_diagram', 'output']
    ]);
  } finally {
    if (widget.isAttached) {
      Widget.detach(widget);
    }
    widget.dispose();
    contents.dispose();
  }
});
