import type { IThemeManager } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import { LauncherModel } from '@jupyterlab/launcher';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import {
  ServerConnection,
  type Contents,
  type Event
} from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate } from '@lumino/disposable';
import { Signal, Stream } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ICurrentProject } from '../../current-project';
import type { IProjectRoot } from '../../project-root';
import type {
  ISessionService,
  ISessionStartOptions,
  SessionState
} from '../../sessions/session-service';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { createContents } from '../../__tests__/project-fixtures';
import { HomeWidget } from '../home-widget';
import { PERSONAS_EVENT_SCHEMA_ID, type PersonaDirectory } from '../personas';

/** A project with two results, a decision, an input and a finding. */
export const RESULTS_SPEC = `version: "0.0.14"
name: Hubble project
description: Measuring the expansion rate.
inputs:
  - id: catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    label: Hubble diagram
    type: figure
    format: png
    inputs: [catalog]
  - id: cosmology_fit
    label: Cosmology fit
    type: table
    format: json
    inputs: [catalog]
decisions:
  cosmological_model:
    label: Cosmological model
    default: flat
    options:
      flat: Flat
      curved: Curved
`;

export class FakeThemeManager implements IThemeManager {
  theme: string | null = 'JupyterLab Light';
  themes: string[] = ['JupyterLab Light'];
  themeChanged = new Signal<this, IChangedArgs<string, string | null>>(this);
  isLight = () => true;
  getDisplayName = (theme: string) => theme;
  themeScrollbars = () => false;
  loadCSS = async () => undefined;
  setTheme = async () => undefined;
  register = () => new DisposableDelegate(() => undefined);
}

/** A current project the tests never change; Home resolves its own. */
export class FakeCurrentProject implements ICurrentProject {
  project: IProjectRoot | null | undefined = undefined;
  readonly changed = new Signal<this, void>(this);
}

/** A session service backed by a map of listings. */
export class FakeSessionService implements ISessionService {
  readonly changed = new Signal<this, string>(this);
  listings = new Map<string, ISessionInfo[]>();
  live = new Map<string, SessionState>();
  readonly list = jest.fn(
    async (entrypoint: string) => this.listings.get(entrypoint) ?? []
  );
  readonly createAndOpen = jest.fn(
    async (entrypoint: string, _options?: ISessionStartOptions) =>
      `${entrypoint.replace(/astra\.yaml$/, '')}chats/untitled.chat`
  );
  readonly openSession = jest.fn(async (_path: string) => undefined);
  activity(path: string): SessionState | undefined {
    return this.live.get(path);
  }
}

/** A Jupyter Events bus whose stream the tests emit into. */
export class FakeEvents implements Event.IManager {
  readonly serverSettings = ServerConnection.makeSettings();
  readonly stream = new Stream<this, Event.Emission>(this);
  isDisposed = false;
  emit = jest.fn(async (_event: Event.Request) => undefined);
  dispose(): void {
    this.isDisposed = true;
  }
}

/** A `personas` event as Jupyter AI's persona manager publishes it. */
export function personasEvent(
  personas: { id: string; name: string }[]
): Event.Emission {
  return {
    schema_id: PERSONAS_EVENT_SCHEMA_ID,
    chat_id: 'chat-1',
    personas: personas.map(persona => ({ ...persona, avatar_url: null }))
  };
}

export function session(overrides: Partial<ISessionInfo> = {}): ISessionInfo {
  return {
    path: 'project/chats/hubble.chat',
    title: 'Hubble diagram with error bars',
    modified: new Date().toISOString(),
    messages: 4,
    lastAgent: 'Codex',
    activity: 'idle',
    ...overrides
  };
}

export const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition instead of a fixed delay. */
export async function until(
  condition: () => boolean,
  timeout = 3000
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for the Home widget.');
    }
    await flush();
  }
}

export interface IHomeHostOptions {
  /** Contents entries; the object stays live, so tests may add files later. */
  entries: Record<string, Contents.IModel>;
  cwd?: string;
  commands?: CommandRegistry;
  sessions?: ISessionService | null;
  personas?: PersonaDirectory | null;
  state?: IStateDB | null;
}

/** A Home tab attached to the document, over in-memory contents. */
export function homeHost(options: IHomeHostOptions) {
  const { contents, get } = createContents(options.entries);
  const commands = options.commands ?? new CommandRegistry();
  const current = new FakeCurrentProject();
  const onOpenTools = jest.fn();
  const widget = new HomeWidget({
    model: new LauncherModel(),
    cwd: options.cwd ?? 'elsewhere',
    commands,
    contents,
    documents: { openOrReveal: jest.fn() },
    rendermime: new RenderMimeRegistry(),
    themes: new FakeThemeManager(),
    current,
    callback: jest.fn(),
    onOpenTools,
    sessions: options.sessions ?? null,
    personas: options.personas ?? null,
    state: options.state ?? null
  });
  Widget.attach(widget, document.body);
  const hidden = (selector: string) =>
    !!widget.node.querySelector(selector)?.classList.contains('lm-mod-hidden');
  const bodies = () => ({
    launcher: !hidden('.jp-jupyterlab-lightcone-Home-launcher'),
    view: !hidden('.jp-jupyterlab-lightcone-HomeView'),
    stockBar: !hidden('.jp-jupyterlab-lightcone-Home-stockBar')
  });
  const query = <T extends Element = HTMLElement>(selector: string) =>
    widget.node.querySelector<T>(selector);
  const queryAll = <T extends Element = HTMLElement>(selector: string) =>
    Array.from(widget.node.querySelectorAll<T>(selector));
  return {
    widget,
    contents,
    get,
    commands,
    changed: current.changed,
    onOpenTools,
    bodies,
    query,
    queryAll,
    text: () => widget.node.textContent ?? '',
    dispose: () => {
      widget.dispose();
      contents.dispose();
    }
  };
}

/** Hide or show the browser tab, the way Lumino's polls observe it. */
export function setDocumentHidden(hidden: boolean): void {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    });
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Type into a React-controlled field the way a browser does. */
export function typeInto(
  field: HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
      bubbles: true
    })
  );
}

/** Press a key in a field. */
export function press(
  field: HTMLElement,
  key: string,
  init: KeyboardEventInit = {}
): void {
  field.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init
    })
  );
}
