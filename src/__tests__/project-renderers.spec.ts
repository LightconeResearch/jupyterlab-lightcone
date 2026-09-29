import type { ResolvedOutput } from '@astra-spec/sdk';
import { ContentsManager } from '@jupyterlab/services';
import React, { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  IDocumentOpener,
  JupyterArtifactAccess
} from '../artifact-access';
import type { ILoadedProjectData } from '../project-data';
import {
  hostArtifactRenderer,
  useProjectRenderers
} from '../project-renderers';
import { withLightconeServer } from './server-fixtures';

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

describe('the paper fetch action', () => {
  const data = {
    document: {},
    index: {},
    bindings: [],
    papers: {}
  } as unknown as ILoadedProjectData;

  /** The `onFetchPaper` slot the renderers hand the ASTRA views. */
  async function fetchSlot(): Promise<((doi: string) => void) | undefined> {
    const contents = new ContentsManager();
    const fetch = jest.fn();
    let slot: ((doi: string) => void) | undefined;
    function Probe(): null {
      slot = useProjectRenderers(
        contents,
        'astra.yaml',
        data,
        fetch,
        {} as IDocumentOpener
      ).onFetchPaper;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(React.createElement(Probe)));
    act(() => root.unmount());
    contents.dispose();
    return slot;
  }

  it('is left out without the server’s paper cache', async () => {
    expect(await fetchSlot()).toBeUndefined();
  });

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    it('fetches into the server’s cache', async () => {
      expect(await fetchSlot()).toEqual(expect.any(Function));
    });
  });
});
