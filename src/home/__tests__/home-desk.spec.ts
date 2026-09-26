import type { Contents } from '@jupyterlab/services';
import { StateDB, type IStateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { CommandIDs } from '../../commands';
import { requestAPI } from '../../request';
import { SidebarCommandIDs } from '../../sidebar/sidebar-commands';
import { PipelineCommandIDs } from '../../versions/pipeline-commands';
import { CREATE_CHAT_COMMAND } from '../../workbench-ids';
import { fileModel } from '../../__tests__/project-fixtures';
import { PersonaDirectory } from '../personas';
import {
  FakeEvents,
  FakeSessionService,
  RESULTS_SPEC,
  flush,
  homeHost,
  personasEvent,
  press,
  session,
  setDocumentHidden,
  typeInto,
  until
} from './home-fixtures';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../api', () => ({
  ...jest.requireActual('../../api'),
  collectPaperMetadata: jest.fn().mockResolvedValue({}),
  fetchPaper: jest.fn()
}));
jest.mock('../../request', () => ({
  ...jest.requireActual('../../request'),
  requestAPI: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));

const request = jest.mocked(requestAPI);
const ENTRYPOINT = 'project/astra.yaml';
const DRAFT_KEY = `jupyterlab_lightcone:home:draft:${ENTRYPOINT}`;
const CODEX = {
  id: 'jupyter-ai-personas::jupyter_ai_acp_client::Codex',
  name: 'Codex'
};
const DAY = 24 * 60 * 60 * 1000;
const C = 'jp-jupyterlab-lightcone-Home';

beforeEach(() => {
  request.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('api/materialization')) {
      return {
        outputs: {
          'default/hubble_diagram': { state: 'current', detail: '' },
          'default/cosmology_fit': { state: 'current', detail: '' }
        }
      };
    }
    if (endpoint.startsWith('api/versions/results')) {
      return {
        commits: [
          {
            commit: 'a'.repeat(40),
            short: 'aaaaaaa',
            time: new Date(Date.now() - 2 * DAY).toISOString(),
            subject: 'Materialize hubble_diagram [default]',
            outputs: [{ universe: 'default', output: 'hubble_diagram' }]
          }
        ]
      };
    }
    return { papers: {} };
  });
});

interface IDeskHostOptions {
  /** Whether Jupyter Chat's create command is registered. */
  chat?: boolean;
  /** Whether the Lightcone sidebar's command is registered. */
  sidebar?: boolean;
  /** Whether the pipeline's command is registered. */
  pipeline?: boolean;
  sessions?: FakeSessionService;
  personas?: PersonaDirectory | null;
  state?: IStateDB | null;
  /** The project's `astra.yaml`; RESULTS_SPEC by default. */
  spec?: string;
}

function deskHost(options: IDeskHostOptions = {}) {
  const commands = new CommandRegistry();
  const executed: [string, ReadonlyPartialJSONObject][] = [];
  const register = (id: string) =>
    commands.addCommand(id, {
      execute: args => {
        executed.push([id, args]);
      }
    });
  for (const id of [
    CommandIDs.openElement,
    CommandIDs.openInventory,
    CommandIDs.openMySTRA
  ]) {
    register(id);
  }
  if (options.chat !== false) {
    register(CREATE_CHAT_COMMAND);
  }
  if (options.sidebar) {
    register(SidebarCommandIDs.showSidebar);
  }
  if (options.pipeline) {
    register(PipelineCommandIDs.openPipeline);
  }
  const sessions = options.sessions ?? new FakeSessionService();
  const entries: Record<string, Contents.IModel> = {
    [ENTRYPOINT]: fileModel(options.spec ?? RESULTS_SPEC)
  };
  const host = homeHost({
    entries,
    cwd: 'project',
    commands,
    sessions,
    personas: options.personas ?? null,
    state: options.state ?? null
  });
  return {
    ...host,
    sessions,
    executed,
    register,
    textarea: () => host.query<HTMLTextAreaElement>(`.${C}-textarea`),
    picker: () => host.query<HTMLSelectElement>(`select.${C}-agent`),
    sessionRows: () => host.queryAll<HTMLButtonElement>(`.${C}-session`)
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('the desk', () => {
  it('is left out until Jupyter Chat can create sessions', async () => {
    const h = deskHost({ chat: false });
    try {
      await until(() => h.text().includes('Hubble project'));
      await flush();
      expect(h.query(`.${C}-desk`)).toBeNull();
      expect(h.text()).not.toContain('New session');
      // Jupyter Chat's plugin may activate after Home.
      h.register(CREATE_CHAT_COMMAND);
      await until(() => h.query(`.${C}-desk`) !== null);
      expect(h.textarea()).not.toBeNull();
    } finally {
      h.dispose();
    }
  });
});

describe('the composer', () => {
  it('starts a session with the typed message and the chosen agent', async () => {
    const events = new FakeEvents();
    const personas = new PersonaDirectory(events);
    const h = deskHost({ personas });
    try {
      await until(() => h.textarea() !== null);
      // No persona advertised yet: a plain Start without a picker.
      expect(h.picker()).toBeNull();
      events.stream.emit(personasEvent([CODEX]));
      await until(() => h.picker() !== null);
      expect(Array.from(h.picker()!.options).map(o => o.textContent)).toEqual([
        'Default agent',
        'Codex'
      ]);

      typeInto(h.textarea()!, 'Plot the Hubble diagram');
      await flush();
      typeInto(h.picker()!, CODEX.id);
      await flush();
      press(h.textarea()!, 'Enter', { shiftKey: true });
      await flush();
      expect(h.sessions.createAndOpen).not.toHaveBeenCalled();

      press(h.textarea()!, 'Enter');
      await until(() => h.sessions.createAndOpen.mock.calls.length === 1);
      expect(h.sessions.createAndOpen).toHaveBeenCalledWith(ENTRYPOINT, {
        firstMessage: 'Plot the Hubble diagram',
        persona: CODEX.id
      });
      await until(() => h.textarea()!.value === '');
      // The agent choice stays for the next session.
      expect(h.picker()!.value).toBe(CODEX.id);
    } finally {
      h.dispose();
      personas.dispose();
    }
  });

  it('shows why a session could not start and keeps the text', async () => {
    const h = deskHost();
    h.sessions.createAndOpen.mockRejectedValueOnce(new Error('offline'));
    try {
      await until(() => h.textarea() !== null);
      typeInto(h.textarea()!, 'Fit the model');
      await flush();
      h.query<HTMLButtonElement>(`.${C}-start`)!.click();
      await until(() => h.query('[role="alert"]') !== null);
      expect(h.query('[role="alert"]')!.textContent).toBe('offline');
      expect(h.textarea()!.value).toBe('Fit the model');
    } finally {
      h.dispose();
    }
  });

  it('addresses a remembered agent only while the directory advertises it', async () => {
    const state = new StateDB();
    await state.save(DRAFT_KEY, {
      text: 'Fit the model',
      persona: 'jupyter-ai-personas::removed::Gone'
    });
    const events = new FakeEvents();
    const personas = new PersonaDirectory(events);
    events.stream.emit(personasEvent([CODEX]));
    const h = deskHost({ personas, state });
    try {
      await until(() => h.textarea()?.value === 'Fit the model');
      // The picker shows the default agent, and the message goes to it.
      expect(h.picker()!.value).toBe('');
      h.query<HTMLButtonElement>(`.${C}-start`)!.click();
      await until(() => h.sessions.createAndOpen.mock.calls.length === 1);
      expect(h.sessions.createAndOpen).toHaveBeenCalledWith(ENTRYPOINT, {
        firstMessage: 'Fit the model'
      });
    } finally {
      h.dispose();
      personas.dispose();
    }
  });

  it('keeps an unsent draft and its agent across reloads', async () => {
    const state = new StateDB();
    const events = new FakeEvents();
    const personas = new PersonaDirectory(events);
    events.stream.emit(personasEvent([CODEX]));
    const first = deskHost({ personas, state });
    try {
      await until(() => first.picker() !== null);
      typeInto(first.textarea()!, 'draft text');
      await flush();
      typeInto(first.picker()!, CODEX.id);
      await wait(400);
      expect(await state.fetch(DRAFT_KEY)).toEqual({
        text: 'draft text',
        persona: CODEX.id
      });
    } finally {
      first.dispose();
    }

    const second = deskHost({ personas, state });
    try {
      await until(() => second.textarea()?.value === 'draft text');
      expect(second.picker()!.value).toBe(CODEX.id);
      // Clearing the text forgets the draft.
      typeInto(second.textarea()!, '');
      await wait(400);
      expect(await state.fetch(DRAFT_KEY)).toBeUndefined();
    } finally {
      second.dispose();
      personas.dispose();
    }
  });
});

describe('the sessions list', () => {
  function sessions(): FakeSessionService {
    const service = new FakeSessionService();
    service.listings.set(ENTRYPOINT, [
      session({ path: 'project/chats/hubble.chat', title: 'Hubble diagram' }),
      session({
        path: 'project/chats/fit.chat',
        title: 'Cosmology fit',
        lastAgent: null
      })
    ]);
    service.live.set('project/chats/fit.chat', 'working');
    return service;
  }

  it('lists the project sessions, opens them and leads to the sidebar', async () => {
    const h = deskHost({ sessions: sessions() });
    try {
      await until(() => h.sessionRows().length === 2);
      expect(
        h
          .sessionRows()
          .map(row => row.querySelector(`.${C}-sessionTitle`)!.textContent)
      ).toEqual(['Hubble diagram', 'Cosmology fit']);
      expect(
        h
          .sessionRows()
          .map(row =>
            row.querySelector(`.${C}-sessionDot`)!.getAttribute('data-activity')
          )
      ).toEqual(['idle', 'working']);
      expect(h.sessionRows()[1].textContent).toContain('working');

      h.sessionRows()[0].click();
      expect(h.sessions.openSession).toHaveBeenCalledWith(
        'project/chats/hubble.chat'
      );

      // Without the sidebar there is nowhere to list them all.
      expect(h.text()).not.toContain('All 2 →');
      h.register(SidebarCommandIDs.showSidebar);
      await until(() => h.text().includes('All 2 →'));
      const all = h
        .queryAll<HTMLButtonElement>(`.${C}-sessions .${C}-link`)
        .find(button => button.textContent === 'All 2 →');
      all!.click();
      await flush();
      expect(h.executed).toContainEqual([SidebarCommandIDs.showSidebar, {}]);
    } finally {
      h.dispose();
    }
  });

  it('is hidden while the project has no sessions', async () => {
    const h = deskHost();
    try {
      await until(() => h.sessions.list.mock.calls.length > 0);
      await flush();
      expect(h.query(`.${C}-sessions`)).toBeNull();
      expect(h.textarea()).not.toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('catches up with sessions started while Home was hidden once it is shown', async () => {
    const service = new FakeSessionService();
    service.listings.set(ENTRYPOINT, [
      session({ path: 'project/chats/hubble.chat', title: 'Hubble diagram' })
    ]);
    const h = deskHost({ sessions: service });
    try {
      await until(() => h.sessionRows().length === 1);
      // A session opens over Home, so the change arrives while it is hidden.
      h.widget.hide();
      service.listings.set(ENTRYPOINT, [
        session({ path: 'project/chats/new.chat', title: 'New question' }),
        session({ path: 'project/chats/hubble.chat', title: 'Hubble diagram' })
      ]);
      service.changed.emit(ENTRYPOINT);
      await flush();
      await flush();
      expect(h.sessionRows()).toHaveLength(1);

      h.widget.show();
      await until(() => h.sessionRows().length === 2);
      expect(h.sessionRows()[0].textContent).toContain('New question');
    } finally {
      h.dispose();
    }
  });

  it('stops reading the sessions while the browser tab is hidden', async () => {
    const service = sessions();
    const h = deskHost({ sessions: service });
    try {
      await until(() => h.sessionRows().length === 2);
      setDocumentHidden(true);
      // Lumino's polls linger for one tick after the browser tab hides.
      service.changed.emit(ENTRYPOINT);
      await wait(50);
      const calls = service.list.mock.calls.length;
      service.changed.emit(ENTRYPOINT);
      await wait(50);
      expect(service.list.mock.calls.length).toBe(calls);

      setDocumentHidden(false);
      service.changed.emit(ENTRYPOINT);
      await until(() => service.list.mock.calls.length > calls);
    } finally {
      setDocumentHidden(false);
      h.dispose();
    }
  });
});

describe('the results', () => {
  it('shows plates under a freshness line and opens them', async () => {
    const h = deskHost();
    try {
      await until(() => h.queryAll(`.${C}-plate`).length === 2);
      await until(() =>
        /All 2 current · last materialized 2 days ago/.test(
          h.query(`.${C}-freshness`)?.textContent ?? ''
        )
      );
      const plates = h.queryAll<HTMLButtonElement>(`.${C}-plate`);
      expect(
        plates.map(plate => plate.querySelector(`.${C}-plateKind`)!.textContent)
      ).toEqual(['Figure', 'Table']);
      // Each plate names its output after the inventory's output mark.
      expect(
        plates.map(plate =>
          plate
            .querySelector(
              `.${C}-plateCaption > .lightcone-brand.astra-ui > .astra-kind-glyph`
            )
            ?.getAttribute('data-kind')
        )
      ).toEqual(['output', 'output']);
      plates[0].click();
      await flush();
      expect(h.executed).toContainEqual([
        CommandIDs.openElement,
        { entrypoint: ENTRYPOINT, target: 'outputs.hubble_diagram' }
      ]);
      h.queryAll<HTMLButtonElement>(`.${C}-link`)
        .find(button => button.textContent === 'See all')!
        .click();
      await flush();
      expect(h.executed).toContainEqual([
        CommandIDs.openInventory,
        { path: ENTRYPOINT }
      ]);
      h.executed.length = 0;
      h.query<HTMLButtonElement>(`.${C}-astra`)!.click();
      await flush();
      expect(h.executed).toContainEqual([
        CommandIDs.openInventory,
        { path: ENTRYPOINT }
      ]);
      // The badges under the title carry the inventory's kind marks.
      const badges = h.queryAll<HTMLElement>(`.${C}-badge`);
      expect(badges.map(badge => badge.dataset.kind)).toEqual([
        'output',
        'decision',
        'input',
        'finding',
        'paper'
      ]);
      expect(
        badges.every(badge =>
          badge.querySelector('.lightcone-brand.astra-ui .astra-kind-glyph')
        )
      ).toBe(true);
      expect(h.text()).toContain('2 results');
      expect(h.text()).toContain('1 decision');
      expect(h.text()).toContain('1 input');
    } finally {
      h.dispose();
    }
  });

  it('links the results line to the pipeline, when the pipeline is there', async () => {
    const pipelineLink = (h: ReturnType<typeof deskHost>) =>
      h.query<HTMLButtonElement>(`.${C}-pipeline`);
    const without = deskHost();
    try {
      await until(() => without.queryAll(`.${C}-plate`).length === 2);
      expect(pipelineLink(without)).toBeNull();
    } finally {
      without.dispose();
    }
    const h = deskHost({ pipeline: true });
    try {
      await until(() => pipelineLink(h) !== null);
      const link = pipelineLink(h)!;
      expect(link.textContent).toBe('Pipeline');
      // It sits in the results line, before See all.
      expect(
        h
          .queryAll<HTMLButtonElement>(
            `.${C}-section[aria-label="Results"] .${C}-link`
          )
          .map(button => button.textContent)
      ).toEqual(['Pipeline', 'See all']);
      link.click();
      await flush();
      expect(h.executed).toContainEqual([
        PipelineCommandIDs.openPipeline,
        { entrypoint: ENTRYPOINT }
      ]);
    } finally {
      h.dispose();
    }
  });

  it('counts the results it shows, leaving a sub-analysis output to its scope', async () => {
    const h = deskHost({
      spec: `${RESULTS_SPEC}analyses:
  checks:
    name: Checks
    inputs:
      - id: residual_data
        type: data
        source: data/residuals.csv
    outputs:
      - id: residuals
        type: figure
        format: png
        inputs: [residual_data]
`
    });
    try {
      await until(() => h.queryAll(`.${C}-plate`).length === 2);
      const badge = (kind: string) =>
        h.query(`.${C}-badge[data-kind="${kind}"]`)?.textContent;
      await until(() => badge('output') !== undefined);
      // Two plates, two results; the nested analysis still adds its input.
      expect(badge('output')).toBe('◆2 results');
      expect(badge('input')).toBe('▤2 inputs');
      const seeAll = h
        .queryAll<HTMLButtonElement>(`.${C}-link`)
        .find(button => button.textContent === 'See all');
      expect(seeAll?.getAttribute('aria-label')).toBe('See all results');
    } finally {
      h.dispose();
    }
  });
});
