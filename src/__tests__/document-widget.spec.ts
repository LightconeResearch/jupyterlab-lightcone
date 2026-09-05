import { DocumentModel, type DocumentRegistry } from '@jupyterlab/docregistry';
import { ContentsManager } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import { PromiseDelegate } from '@lumino/coreutils';
import { LightconeDocumentWidget } from '../document-widget';
import { loadProject, type ILoadedProject } from '../project-data';

jest.mock('../project-data', () => ({
  ...jest.requireActual('../project-data'),
  loadProject: jest.fn()
}));
const load = jest.mocked(loadProject);
const project = (name: string): ILoadedProject =>
  ({
    document: { analysis: { name }, universe: { universeId: 'default' } },
    index: { analysisByPath: new Map([['$', {}]]), recordByPath: new Map() },
    bindings: []
  }) as unknown as ILoadedProject;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

it('waits for readiness, ignores old results after rename, and releases its subscription', async () => {
  const ready = new PromiseDelegate<void>();
  const model = new DocumentModel();
  const sender = { localPath: 'astra.yaml' };
  const pathChanged = new Signal<typeof sender, string>(sender);
  const context = {
    path: 'first/astra.yaml',
    localPath: 'first/astra.yaml',
    ready: ready.promise,
    pathChanged,
    model
  };
  const contents = new ContentsManager();
  const first = new PromiseDelegate<ILoadedProject>();
  const second = new PromiseDelegate<ILoadedProject>();
  load
    .mockReset()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const widget = new LightconeDocumentWidget(
    context as unknown as DocumentRegistry.Context,
    contents
  );
  expect(widget.content.node.textContent).toContain('Loading');
  expect(load).not.toHaveBeenCalled();
  ready.resolve();
  await settle();
  expect(load).toHaveBeenCalledWith(contents, 'first/astra.yaml');
  context.path = context.localPath = 'second/astra.yaml';
  pathChanged.emit(context.path);
  await settle();
  second.resolve(project('Second'));
  await settle();
  expect(widget.content.node.textContent).toContain('Second');
  first.resolve(project('First'));
  await settle();
  expect(widget.content.node.textContent).not.toContain('First');
  widget.dispose();
  pathChanged.emit('third/astra.yaml');
  await settle();
  expect(load).toHaveBeenCalledTimes(2);
  contents.dispose();
  model.dispose();
});

it('does not render a late failure after close', async () => {
  const model = new DocumentModel();
  const sender = { localPath: 'astra.yaml' };
  const context = {
    path: 'astra.yaml',
    localPath: 'astra.yaml',
    ready: Promise.resolve(),
    pathChanged: new Signal<typeof sender, string>(sender),
    model
  };
  const contents = new ContentsManager();
  const pending = new PromiseDelegate<ILoadedProject>();
  load.mockReset().mockReturnValue(pending.promise);
  const widget = new LightconeDocumentWidget(
    context as unknown as DocumentRegistry.Context,
    contents
  );
  await settle();
  widget.dispose();
  const text = widget.content.node.textContent;
  pending.reject(new Error('late failure'));
  await settle();
  expect(widget.content.node.textContent).toBe(text);
  contents.dispose();
  model.dispose();
});
