import type { Contents } from '@jupyterlab/services';
import { StateDB, type IStateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import {
  PromiseDelegate,
  type ReadonlyPartialJSONObject
} from '@lumino/coreutils';
import { CommandIDs } from '../../commands';
import { OPEN_REPORT_COMMAND } from '../home-commands';
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
    if (endpoint.startsWith('api/project-agents')) {
      return { personas: [CODEX], default: CODEX.id };
    }
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
            subject: 'Manual result correction',
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
    OPEN_REPORT_COMMAND
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
    picker: () => host.query<HTMLButtonElement>(`.${C}-agentPicker button`),
    sessionRows: () => host.queryAll<HTMLButtonElement>(`.${C}-session`)
  };
}

/** Select through the same menu interaction as the chat picker. */
async function chooseAgent(
  button: HTMLButtonElement,
  name: string
): Promise<void> {
  button.click();
  const item = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(node => node.textContent === name);
  await until(() => !!item());
  item()!.click();
  await flush();
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
      // Available before any chat has advertised a persona list.
      await until(() => h.picker()?.textContent === CODEX.name);
      expect(h.picker()!.title).toBe('Choose an agent');

      typeInto(h.textarea()!, 'Plot the Hubble diagram');
      await flush();
      await chooseAgent(h.picker()!, CODEX.name);
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
      expect(h.picker()!.textContent).toBe(CODEX.name);
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
      expect(h.picker()!.textContent).toBe(CODEX.name);
      h.query<HTMLButtonElement>(`.${C}-start`)!.click();
      await until(() => h.sessions.createAndOpen.mock.calls.length === 1);
      expect(h.sessions.createAndOpen).toHaveBeenCalledWith(ENTRYPOINT, {
        firstMessage: 'Fit the model',
        persona: CODEX.id
      });
    } finally {
      h.dispose();
      personas.dispose();
    }
  });

  it('refreshes project choices when a persona is removed from a live chat', async () => {
    const other = { id: 'jupyter-ai-personas::other::Other', name: 'Other' };
    let agents = { personas: [CODEX, other], default: CODEX.id };
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (endpoint, ...args) =>
      endpoint.startsWith('api/project-agents')
        ? agents
        : original(endpoint, ...args)
    );
    const events = new FakeEvents();
    const personas = new PersonaDirectory(events);
    const h = deskHost({ personas });
    try {
      await until(() => h.picker()?.textContent === CODEX.name);
      events.stream.emit(personasEvent([CODEX, other]));
      await wait(150);
      agents = { personas: [other], default: other.id };
      events.stream.emit(personasEvent([other]));
      await until(() => h.picker()?.textContent === other.name);
    } finally {
      h.dispose();
      personas.dispose();
    }
  });

  it('keeps edits made before a slow draft restore completes', async () => {
    const state = new StateDB();
    const loading = new PromiseDelegate<ReadonlyPartialJSONObject>();
    const fetch = state.fetch.bind(state);
    jest.spyOn(state, 'fetch').mockImplementationOnce(() => loading.promise);
    const h = deskHost({ state });
    try {
      await until(() => h.textarea() !== null);
      typeInto(h.textarea()!, 'New question');
      await flush();
      loading.resolve({ text: 'Old draft', persona: CODEX.id });
      await flush();
      expect(h.textarea()!.value).toBe('New question');
      await wait(400);
      expect(await fetch(DRAFT_KEY)).toEqual({
        text: 'New question',
        persona: ''
      });
    } finally {
      h.dispose();
    }
  });

  it('flushes the last edits when Home closes before the debounce expires', async () => {
    const state = new StateDB();
    const h = deskHost({ state });
    try {
      await until(() => h.textarea() !== null);
      typeInto(h.textarea()!, 'Last edit before closing');
      await flush();
    } finally {
      h.dispose();
    }
    await flush();
    expect(await state.fetch(DRAFT_KEY)).toEqual({
      text: 'Last edit before closing',
      persona: ''
    });
  });

  it('removes a sent draft after an earlier slow save finishes', async () => {
    const state = new StateDB();
    const saving = new PromiseDelegate<void>();
    const save = state.save.bind(state);
    const saved = jest
      .spyOn(state, 'save')
      .mockImplementationOnce((key, value) =>
        saving.promise.then(() => save(key, value))
      );
    const removed = jest.spyOn(state, 'remove');
    const h = deskHost({ state });
    try {
      await until(() => h.picker()?.textContent === CODEX.name);
      typeInto(h.textarea()!, 'Send while the draft saves');
      await until(() => saved.mock.calls.length === 1);
      h.query<HTMLButtonElement>(`.${C}-start`)!.click();
      await until(() => h.textarea()!.value === '');
    } finally {
      h.dispose();
    }
    await flush();
    expect(removed).not.toHaveBeenCalled();
    saving.resolve();
    await until(() => removed.mock.calls.length === 1);
    expect(await state.fetch(DRAFT_KEY)).toBeUndefined();
  });

  it('does not restore a sent draft after Home closes', async () => {
    const state = new StateDB();
    await state.save(DRAFT_KEY, { text: 'Send this', persona: CODEX.id });
    const h = deskHost({ state });
    try {
      await until(() => h.textarea()?.value === 'Send this');
      await until(() => h.picker()?.textContent === CODEX.name);
      h.query<HTMLButtonElement>(`.${C}-start`)!.click();
      await until(() => h.textarea()!.value === '');
    } finally {
      h.dispose();
    }
    await flush();
    expect(await state.fetch(DRAFT_KEY)).toBeUndefined();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'keeps Enter used to confirm IME input in the composer (%j)',
    async keyboard => {
      const h = deskHost();
      try {
        await until(() => h.picker()?.textContent === CODEX.name);
        typeInto(h.textarea()!, '入力中');
        await flush();
        press(h.textarea()!, 'Enter', keyboard);
        await flush();
        expect(h.sessions.createAndOpen).not.toHaveBeenCalled();
        expect(h.textarea()!.value).toBe('入力中');
        press(h.textarea()!, 'Enter');
        await until(() => h.sessions.createAndOpen.mock.calls.length === 1);
      } finally {
        h.dispose();
      }
    }
  );

  it('keeps an unsent draft and its agent across reloads', async () => {
    const state = new StateDB();
    const events = new FakeEvents();
    const personas = new PersonaDirectory(events);
    events.stream.emit(personasEvent([CODEX]));
    const first = deskHost({ personas, state });
    try {
      await until(() => first.picker()?.textContent === CODEX.name);
      typeInto(first.textarea()!, 'draft text');
      await flush();
      await chooseAgent(first.picker()!, CODEX.name);
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
      expect(second.picker()!.textContent).toBe(CODEX.name);
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
      const all = () => h.query<HTMLButtonElement>(`.${C}-sessions .${C}-link`);
      expect(all()).toBeNull();
      h.register(SidebarCommandIDs.showSidebar);
      await until(() => all() !== null);
      expect(all()!.textContent).toBe('All 2');
      all()!.click();
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
  it('labels the latest results commit without claiming an engine run and opens the plates', async () => {
    const h = deskHost();
    try {
      await until(() => h.queryAll(`.${C}-plate`).length === 2);
      await until(() =>
        /All 2 current · results updated 2 days ago/.test(
          h.query(`.${C}-freshness`)?.textContent ?? ''
        )
      );
      const plates = h.queryAll<HTMLButtonElement>(`.${C}-plate`);
      expect(
        plates.map(plate => plate.querySelector(`.${C}-plateKind`)!.textContent)
      ).toEqual(['Figure', 'Table']);
      // Each plate's caption names its output, then its kind after the
      // inventory's output mark.
      expect(
        plates.map(plate => plate.querySelector(`.${C}-plateName`)!.textContent)
      ).toEqual(['Hubble diagram', 'Cosmology fit']);
      expect(
        plates.map(plate =>
          plate
            .querySelector(
              `.${C}-plateMeta > .lightcone-brand.astra-ui > .astra-kind-glyph`
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
        .find(button => button.textContent === 'All 2 results')!
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
      // The colophon under the title carries the inventory's kind marks.
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
      // It sits in the results heading, before the link to all the results.
      expect(
        h
          .queryAll<HTMLButtonElement>(
            `.${C}-results > .${C}-sectionHead > .${C}-link`
          )
          .map(button => button.textContent)
      ).toEqual(['Pipeline', 'All 2 results']);
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
      // The link to all the results counts the same results.
      expect(
        h
          .queryAll<HTMLButtonElement>(`.${C}-link`)
          .some(button => button.textContent === 'All 2 results')
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('names the results past the plates, each one click away', async () => {
    const runs = Array.from(
      { length: 9 },
      (_, index) => `  - id: run_${index + 1}
    label: Run ${index + 1}
    type: data
    format: csv
    inputs: [catalog]
`
    ).join('');
    const h = deskHost({
      spec: RESULTS_SPEC.replace('decisions:\n', `${runs}decisions:\n`)
    });
    try {
      await until(() => h.queryAll(`.${C}-plate`).length === 8);
      // Figures and tables come first on the plates; the last three runs
      // are named in the line after them.
      const more = h.query(`.${C}-more`)!;
      expect(more.querySelector(`.${C}-moreLabel`)!.textContent).toBe('3 more');
      const links = h.queryAll<HTMLButtonElement>(`.${C}-moreLink`);
      expect(links.map(link => link.textContent)).toEqual([
        'Run 7',
        'Run 8',
        'Run 9'
      ]);
      links[1].click();
      await flush();
      expect(h.executed).toContainEqual([
        CommandIDs.openElement,
        { entrypoint: ENTRYPOINT, target: 'outputs.run_8' }
      ]);
      // The line ends with the way to all of them.
      more.querySelector<HTMLButtonElement>(`.${C}-link`)!.click();
      await flush();
      expect(h.executed).toContainEqual([
        CommandIDs.openInventory,
        { path: ENTRYPOINT }
      ]);
      expect(more.querySelector(`.${C}-link`)!.textContent).toBe(
        'All 11 results'
      );
    } finally {
      h.dispose();
    }
  });

  it('leaves the line out while every result has a plate', async () => {
    const h = deskHost();
    try {
      await until(() => h.queryAll(`.${C}-plate`).length === 2);
      expect(h.query(`.${C}-more`)).toBeNull();
    } finally {
      h.dispose();
    }
  });
});
