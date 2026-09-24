import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';
import { FakeThemeManager } from '../../home/__tests__/home-fixtures';
import { requestAPI } from '../../request';
import { createContents, fileModel } from '../../__tests__/project-fixtures';
import { until } from '../../runs/__tests__/runs-fixtures';
import { PipelineWidget } from '../pipeline-view';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));

const ENTRYPOINT = 'project/astra.yaml';
const SPEC = `version: "0.0.14"
name: Pipeline project
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
`;

beforeEach(() => {
  jest.mocked(requestAPI).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return {
        outputs: { 'default/hubble_diagram': { state: 'current', detail: '' } }
      };
    }
    return { papers: {} };
  });
});

test('pipeline nodes and counts carry the inventory’s kind marks', async () => {
  const { contents } = createContents({ [ENTRYPOINT]: fileModel(SPEC) });
  const widget = new PipelineWidget(
    ENTRYPOINT,
    contents,
    new FakeThemeManager(),
    new CommandRegistry()
  );
  Widget.attach(widget, document.body);
  try {
    const node = widget.node;
    await until(
      () =>
        node.querySelectorAll('.jp-jupyterlab-lightcone-Pipeline-node')
          .length === 2
    );
    const kindOf = (scope: Element) =>
      Array.from(
        scope.querySelectorAll('.lightcone-brand.astra-ui > .astra-kind-glyph'),
        glyph => glyph.getAttribute('data-kind')
      );
    // One mark per node, drawn by ASTRA UI inside the SVG.
    const nodes = Array.from(
      node.querySelectorAll<SVGGElement>(
        '.jp-jupyterlab-lightcone-Pipeline-node'
      )
    );
    expect(nodes.map(item => [item.dataset.kind, kindOf(item)])).toEqual([
      ['input', ['input']],
      ['output', ['output']]
    ]);
    expect(
      nodes.every(item =>
        item.querySelector(
          'foreignObject.jp-jupyterlab-lightcone-Pipeline-kind'
        )
      )
    ).toBe(true);
    // The header counts inputs and outputs behind the same marks.
    const header = node.querySelector(
      '.jp-jupyterlab-lightcone-Pipeline-header p'
    );
    expect(header && kindOf(header)).toEqual(['input', 'output']);
    expect(header?.textContent).toContain('1 input');
    expect(header?.textContent).toContain('1 output');
  } finally {
    Widget.detach(widget);
    widget.dispose();
    contents.dispose();
  }
});
