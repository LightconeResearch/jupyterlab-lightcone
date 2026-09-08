import type { ResolvedOutput } from '@astra-spec/sdk';
import { isValidElement } from 'react';
import type { JupyterArtifactAccess } from '../artifact-access';
import { hostArtifactRenderer } from '../project-renderers';

jest.mock('../pdf-runtime', () => ({ loadPdfJs: jest.fn() }));

function output(type: ResolvedOutput['type']): ResolvedOutput {
  return {
    id: 'sample',
    canonicalPath: 'outputs.sample',
    kind: 'output',
    type,
    active: true
  } as unknown as ResolvedOutput;
}

describe('host artifact renderer', () => {
  const access = {
    bindingFor: () => undefined
  } as unknown as JupyterArtifactAccess;
  const render = hostArtifactRenderer(access);

  it('previews figures and tables in the detail dialog', () => {
    expect(isValidElement(render(output('figure'), { compact: false }))).toBe(
      true
    );
    expect(isValidElement(render(output('table'), { compact: false }))).toBe(
      true
    );
  });

  it('opts out of the artifact box for outputs without a picture to frame', () => {
    expect(render(output('data'), { compact: false })).toBeNull();
    expect(render(output('metric'), { compact: false })).toBeNull();
  });

  it('always previews cards and tiles', () => {
    for (const type of ['figure', 'table', 'metric', 'data'] as const) {
      expect(isValidElement(render(output(type), { compact: true }))).toBe(
        true
      );
    }
  });
});
