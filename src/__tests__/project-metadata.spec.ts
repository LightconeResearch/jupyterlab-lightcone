import type { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentModel } from '@jupyterlab/docregistry';
import { parse } from 'yaml';
import {
  renameProject,
  updateProjectDescription,
  withProjectDescription,
  withProjectName
} from '../project-metadata';
import { analysis, createContents, fileModel } from './project-fixtures';

it('changes only the name while preserving YAML comments and string values', () => {
  const source = `${analysis('Old name')}# Research notes\ndescription: Keep this overview.\n`;
  const renamed = withProjectName(source, '  A study: "2026" #1  ');
  expect(parse(renamed)).toEqual({
    ...parse(source),
    name: 'A study: "2026" #1'
  });
  expect(renamed).toContain('# Research notes');
});

it.each(['', '  ', 'First\nsecond', 'bad\0name'])(
  'refuses an invalid name %j',
  name => {
    expect(() => withProjectName(analysis('Original'), name)).toThrow(
      'Enter a project name'
    );
  }
);

it.each(['name: [', '- not a project', 'name: one\nname: two'])(
  'refuses malformed project YAML %j',
  source => {
    expect(() => withProjectName(source, 'Renamed')).toThrow('valid YAML');
  }
);

it('saves a closed project on its original Contents drive', async () => {
  const path = 'archive:project/astra.yaml';
  const source = analysis('Original');
  const { contents } = createContents({ [path]: fileModel(source) });
  const save = jest.spyOn(contents, 'save').mockResolvedValue(fileModel(''));
  try {
    await renameProject(
      contents,
      { findWidget: () => undefined },
      path,
      'Renamed'
    );
    expect(save).toHaveBeenCalledWith(path, {
      type: 'file',
      format: 'text',
      content: withProjectName(source, 'Renamed')
    });
  } finally {
    contents.dispose();
  }
});

it('preserves unsaved editor changes when renaming an open project', async () => {
  const path = 'project/astra.yaml';
  const { contents, get } = createContents({
    [path]: fileModel(analysis('Old'))
  });
  const model = new DocumentModel();
  model.fromString(`${analysis('Old')}description: An unsaved edit.\n`);
  const save = jest.fn().mockResolvedValue(undefined);
  const widget = {
    context: { ready: Promise.resolve(), model, save }
  } as unknown as NonNullable<ReturnType<IDocumentManager['findWidget']>>;
  try {
    await renameProject(contents, { findWidget: () => widget }, path, 'New');
    expect(parse(model.toString())).toMatchObject({
      name: 'New',
      description: 'An unsaved edit.'
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  } finally {
    model.dispose();
    contents.dispose();
  }
});

it('leaves a read-only project intact', async () => {
  const path = 'project/astra.yaml';
  const { contents } = createContents({
    [path]: fileModel(analysis('Original'), { writable: false })
  });
  const save = jest.spyOn(contents, 'save');
  try {
    await expect(
      renameProject(contents, { findWidget: () => undefined }, path, 'New')
    ).rejects.toThrow('read-only');
    expect(save).not.toHaveBeenCalled();
  } finally {
    contents.dispose();
  }
});

it('stores paragraphs and YAML punctuation without changing other metadata', () => {
  const source = `${analysis('Original')}# Research notes\ndescription: Old description\n`;
  const description = 'Question: does A > B?\n\nFindings: "yes" # preliminary';
  const updated = withProjectDescription(source, description);
  expect(parse(updated)).toEqual({
    ...parse(source),
    description: description
  });
  expect(updated).toContain('# Research notes');
  expect(parse(withProjectDescription(updated, '  ')).description).toBe('');
});

it('saves a description while preserving unsaved changes in the open editor', async () => {
  const path = 'project/astra.yaml';
  const { contents, get } = createContents({
    [path]: fileModel(analysis('Old'))
  });
  const model = new DocumentModel();
  model.fromString(`${analysis('Unsaved name')}# Unsaved notes\n`);
  const save = jest.fn().mockResolvedValue(undefined);
  const widget = {
    context: { ready: Promise.resolve(), model, save }
  } as unknown as NonNullable<ReturnType<IDocumentManager['findWidget']>>;
  try {
    await updateProjectDescription(
      contents,
      { findWidget: () => widget },
      path,
      'First.\n\nSecond.'
    );
    expect(parse(model.toString())).toMatchObject({
      name: 'Unsaved name',
      description: 'First.\n\nSecond.'
    });
    expect(model.toString()).toContain('# Unsaved notes');
    expect(save).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  } finally {
    model.dispose();
    contents.dispose();
  }
});
