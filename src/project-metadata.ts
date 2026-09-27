import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import { isMap, parseDocument } from 'yaml';

/** Change the display name while retaining YAML comments and other fields. */
export function withProjectName(source: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) {
    throw new Error('Enter a project name on one line.');
  }
  return withProjectField(source, 'name', trimmed);
}

/** Store the description in ASTRA's description field, including paragraph breaks. */
export function withProjectDescription(
  source: string,
  description: string
): string {
  if (description.includes('\0')) {
    throw new Error('The description cannot contain null characters.');
  }
  return withProjectField(source, 'description', description.trim());
}

/** Update a metadata field without discarding YAML comments or unrelated fields. */
function withProjectField(
  source: string,
  field: 'name' | 'description',
  value: string
): string {
  const document = parseDocument(source);
  if (document.errors.length || !isMap(document.contents)) {
    throw new Error(
      'The project specification must be valid YAML before it can be edited.'
    );
  }
  document.set(field, value);
  return document.toString();
}

/** Save a display name through an open document, or Contents when it is closed. */
export async function renameProject(
  contents: Contents.IManager,
  documents: Pick<IDocumentManager, 'findWidget'>,
  entrypoint: string,
  name: string
): Promise<void> {
  await saveProjectMetadata(contents, documents, entrypoint, source =>
    withProjectName(source, name)
  );
}

/** Save the analysis description through the same document flow as its name. */
export async function updateProjectDescription(
  contents: Contents.IManager,
  documents: Pick<IDocumentManager, 'findWidget'>,
  entrypoint: string,
  description: string
): Promise<void> {
  await saveProjectMetadata(contents, documents, entrypoint, source =>
    withProjectDescription(source, description)
  );
}

/** Apply an edit to the freshest text, including unsaved changes in open editors. */
async function saveProjectMetadata(
  contents: Contents.IManager,
  documents: Pick<IDocumentManager, 'findWidget'>,
  entrypoint: string,
  edit: (source: string) => string
): Promise<void> {
  const widget = documents.findWidget(entrypoint, null);
  if (widget) {
    const { context } = widget;
    await context.ready;
    if (context.model.readOnly) {
      throw new Error('This project is read-only.');
    }
    // Use the current text model so an open editor's changes are preserved.
    context.model.fromString(edit(context.model.toString()));
    await context.save();
    return;
  }
  const file = await contents.get(entrypoint, {
    type: 'file',
    format: 'text',
    content: true
  });
  if (!file.writable) {
    throw new Error('This project is read-only.');
  }
  if (
    file.type !== 'file' ||
    file.format !== 'text' ||
    typeof file.content !== 'string'
  ) {
    throw new Error('The project specification could not be read as text.');
  }
  await contents.save(entrypoint, {
    type: 'file',
    format: 'text',
    content: edit(file.content)
  });
}
