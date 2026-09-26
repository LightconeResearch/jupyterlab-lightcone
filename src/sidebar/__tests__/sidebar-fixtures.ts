import { DocumentWidget, type DocumentRegistry } from '@jupyterlab/docregistry';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import type {
  ISessionService,
  SessionState
} from '../../sessions/session-service';
import type { ISessionInfo } from '../../sessions/sessions-api';

/**
 * A project with a figure, a table, an output the default universe does not
 * make (it needs the curved model), a decision, a finding and a child analysis.
 */
export const PROJECT_SPEC = `version: "0.0.14"
name: Sidebar project
description: A project for the sidebar tests.
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    type: figure
    format: png
    inputs: [catalog]
  - id: cosmology_fit
    type: table
    format: json
    inputs: [catalog]
  - id: curvature_posterior
    type: figure
    format: png
    inputs: [catalog]
    when: [cosmological_model.curved]
decisions:
  cosmological_model:
    label: Cosmological model
    default: flat
    options:
      flat: Flat
      curved: Curved
findings:
  tension:
    claim: The data show a tension.
    created_at: "2026-09-01T00:00:00Z"
    evidence:
      - id: paper
        doi: 10.1234/abc
analyses:
  systematics:
    name: Systematics
    inputs: []
    outputs:
      - id: residuals
        type: data
        format: npz
`;

export function session(overrides: Partial<ISessionInfo> = {}): ISessionInfo {
  return {
    path: 'project/chats/hubble.chat',
    title: 'Hubble diagram with error bars',
    modified: '2026-09-23T10:00:00Z',
    messages: 4,
    lastAgent: 'Lightcone Agent',
    activity: 'idle',
    ...overrides
  };
}

/** A settable current project. */
export class FakeCurrentProject implements ICurrentProject {
  constructor(public project: IProjectRoot | null | undefined) {}
  readonly changed = new Signal<this, void>(this);
  set(project: IProjectRoot | null | undefined): void {
    this.project = project;
    this.changed.emit();
  }
}

/** A session service backed by a map of listings. */
export class FakeSessionService implements ISessionService {
  readonly changed = new Signal<this, string>(this);
  listings = new Map<string, ISessionInfo[]>();
  live = new Map<string, SessionState>();
  failures = new Map<string, Error>();
  readonly list = jest.fn(async (entrypoint: string) => {
    const failure = this.failures.get(entrypoint);
    if (failure) {
      throw failure;
    }
    return this.listings.get(entrypoint) ?? [];
  });
  readonly createAndOpen = jest.fn(async (entrypoint: string) => {
    return `${entrypoint.replace(/astra\.yaml$/, '')}chats/untitled.chat`;
  });
  readonly openSession = jest.fn(async () => undefined);
  activity(path: string): SessionState | undefined {
    return this.live.get(path);
  }
}

/** Poll until `predicate` holds, failing after `timeout` ms. */
export async function until(
  predicate: () => boolean,
  timeout = 2000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for a condition.');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** The context of a fake chat panel: a path that moves when the file is renamed. */
class FakeChatContext {
  constructor(public path: string) {}
  readonly pathChanged = new Signal<this, string>(this);
  readonly ready = Promise.resolve();
  readonly model = { stateChanged: new Signal<object, unknown>({}) };
  get localPath(): string {
    return this.path;
  }
  readonly rename = jest.fn(async () => undefined);
}

/**
 * A session as Jupyter Chat opens one in the main area: a document widget
 * whose model names the chat file, which `isSessionWidget` recognizes.
 * `rename` moves the file the way the document manager does.
 */
export class FakeChatPanel extends DocumentWidget {
  constructor(path: string) {
    const chatContext = new FakeChatContext(path);
    super({
      context: chatContext as unknown as DocumentRegistry.Context,
      content: new Widget()
    });
    this._chatContext = chatContext;
  }

  readonly area = 'main';

  get model(): {
    name: string;
    input: object;
    messages: unknown[];
    ready: Promise<void>;
  } {
    return {
      name: this._chatContext.path,
      input: {},
      messages: [],
      ready: this._chatContext.ready
    };
  }

  rename(path: string): void {
    this._chatContext.path = path;
    this._chatContext.pathChanged.emit(path);
  }

  private readonly _chatContext: FakeChatContext;
}
