import type { Contents } from '@jupyterlab/services';
import {
  assembleLoadedProject,
  resolveProject,
  projectErrorMessage
} from '../project-data';
import {
  elementSnapshot,
  saveElementAttachment,
  readElementAttachment,
  isElementAttachment,
  validateElementAttachments
} from '../element-attachment';
import { createContents, fileModel } from './project-fixtures';

const yaml = `version: "0.0.14"
name: Attachments
inputs:
  - id: catalog
    type: data
outputs:
  - id: plot
    type: figure
    format: png
decisions:
  method:
    label: Which estimator?
    options:
      robust:
        label: Robust
        insights: [support]
    default: robust
    rationale: Stable under perturbations.
prior_insights:
  support:
    claim: Repeated trials support this choice.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: 10.1234/example
findings:
  result:
    created_at: "2026-01-01T00:00:00Z"
    claim: The plot shows agreement.
    evidence:
      - id: figure
        artifact: plot
`;

async function setup() {
  const entries: Record<string, Contents.IModel> = {
    'project/astra.yaml': fileModel(yaml),
    'project/catalog.txt': fileModel('catalog')
  };
  const { contents } = createContents(entries);
  const save = jest
    .spyOn(contents, 'save')
    .mockImplementation(async (path, model) => {
      const file = { ...fileModel(''), ...model, path };
      entries[path] = file;
      return file;
    });
  const { bundle } = await resolveProject(contents, 'project/astra.yaml').catch(
    error => {
      throw new Error(projectErrorMessage(error));
    }
  );
  return { contents, save, entries, data: assembleLoadedProject(bundle, {}) };
}

test('freezes decision choice and evidence, and resolves each supported kind', async () => {
  const { contents, data } = await setup();
  try {
    const snapshot = elementSnapshot(data, {
      entrypoint: 'project/astra.yaml',
      target: 'decisions.method'
    });
    expect(snapshot.reference).toMatchObject({
      target: 'decisions.method',
      universeId: null
    });
    expect(snapshot.record).toMatchObject({
      selectedOptionId: 'robust',
      rationale: 'Stable under perturbations.'
    });
    expect(snapshot.relatedRecords.map(item => item.canonicalPath)).toEqual([
      'prior_insights.support'
    ]);
    data.document.analysis.decisions[0].rationale = 'Changed later';
    expect(snapshot.record).toMatchObject({
      rationale: 'Stable under perturbations.'
    });
    for (const target of [
      'inputs.catalog',
      'outputs.plot',
      'findings.result'
    ]) {
      expect(
        elementSnapshot(data, { entrypoint: 'project/astra.yaml', target })
          .record.canonicalPath
      ).toBe(target);
    }
    expect(() =>
      elementSnapshot(data, {
        entrypoint: 'project/astra.yaml',
        target: 'decisions.missing'
      })
    ).toThrow('TARGET_NOT_FOUND');
  } finally {
    contents.dispose();
  }
});

test('persists a native attachment once per content version and rejects altered snapshots', async () => {
  const { contents, data, save, entries } = await setup();
  try {
    const snapshot = elementSnapshot(data, {
      entrypoint: 'project/astra.yaml',
      target: 'decisions.method'
    });
    const first = await saveElementAttachment(contents, snapshot);
    expect(isElementAttachment(first)).toBe(true);
    expect(first.value).toMatch(
      /^project\/chat-attachments\/[a-f0-9]{64}\/decisions.method.json$/
    );
    expect(await readElementAttachment(contents, first)).toEqual(snapshot);
    save.mockClear();
    expect(await saveElementAttachment(contents, snapshot)).toEqual(first);
    expect(save).not.toHaveBeenCalled();
    const changed = {
      ...snapshot,
      record: { ...snapshot.record, description: 'New version' }
    };
    const second = await saveElementAttachment(contents, changed);
    expect(second.value).not.toBe(first.value);
    entries[first.value] = {
      ...entries[first.value],
      content: JSON.stringify(changed)
    };
    await expect(readElementAttachment(contents, first)).rejects.toThrow(
      'changed'
    );
    await expect(saveElementAttachment(contents, snapshot)).rejects.toThrow(
      'changed'
    );
  } finally {
    contents.dispose();
  }
});

test('rejects another project or universe before submit, and ignores normal file attachments', async () => {
  const { contents, data } = await setup();
  try {
    const snapshot = elementSnapshot(data, {
      entrypoint: 'project/astra.yaml',
      target: 'inputs.catalog'
    });
    const attachment = await saveElementAttachment(contents, snapshot);
    const context = {
      version: 1 as const,
      entrypoint: 'project/astra.yaml',
      universeId: null
    };
    await expect(
      validateElementAttachments(contents, [attachment], context)
    ).resolves.toBeUndefined();
    for (const other of [
      undefined,
      { ...context, entrypoint: 'other/astra.yaml' },
      { ...context, universeId: 'other' }
    ]) {
      await expect(
        validateElementAttachments(contents, [attachment], other)
      ).rejects.toThrow('another project or universe');
    }
    await expect(
      validateElementAttachments(
        contents,
        [{ type: 'file', value: 'normal.txt' }],
        undefined
      )
    ).resolves.toBeUndefined();
  } finally {
    contents.dispose();
  }
});
