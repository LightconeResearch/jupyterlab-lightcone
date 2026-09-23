import { StateDB } from '@jupyterlab/statedb';
import { PersonaDirectory, PERSONAS_STATE_KEY } from '../personas';
import { FakeEvents, flush, personasEvent } from './home-fixtures';

jest.mock('../../pdf-runtime', () => ({}));

const CODEX = {
  id: 'jupyter-ai-personas::jupyter_ai_acp_client::Codex',
  name: 'Codex'
};
const CLAUDE = {
  id: 'jupyter-ai-personas::jupyter_ai_acp_client::Claude',
  name: 'Claude'
};

describe('PersonaDirectory', () => {
  it('fills from the events of open chats, merging every chat', () => {
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events);
    const changed = jest.fn();
    directory.changed.connect(changed);
    events.stream.emit(personasEvent([CODEX]));
    events.stream.emit({
      schema_id: 'https://example.org/other',
      personas: []
    });
    events.stream.emit(personasEvent([CLAUDE]));
    expect(directory.personas).toEqual([CODEX, CLAUDE]);
    expect(changed).toHaveBeenCalledTimes(2);
    directory.dispose();
    events.stream.emit(personasEvent([{ id: 'x', name: 'X' }]));
    expect(directory.personas).toEqual([CODEX, CLAUDE]);
  });

  it('offers the personas of an earlier session before any chat opens', async () => {
    const events = new FakeEvents();
    const state = new StateDB();
    const first = new PersonaDirectory(events, state);
    events.stream.emit(personasEvent([CODEX, CLAUDE]));
    await flush();
    expect(await state.fetch(PERSONAS_STATE_KEY)).toEqual([CODEX, CLAUDE]);
    first.dispose();

    // A reload: no chat is open, so no event arrives.
    const reloaded = new PersonaDirectory(new FakeEvents(), state);
    const changed = jest.fn();
    reloaded.changed.connect(changed);
    await flush();
    expect(reloaded.personas).toEqual([CODEX, CLAUDE]);
    expect(changed).toHaveBeenCalledTimes(1);
    reloaded.dispose();
  });

  it('lets the first live list replace the remembered one', async () => {
    const state = new StateDB();
    await state.save(PERSONAS_STATE_KEY, [CODEX, CLAUDE]);
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events, state);
    await flush();
    expect(directory.personas).toEqual([CODEX, CLAUDE]);

    // Codex was uninstalled: the first chat to open advertises Claude alone.
    events.stream.emit(personasEvent([CLAUDE]));
    expect(directory.personas).toEqual([CLAUDE]);
    await flush();
    expect(await state.fetch(PERSONAS_STATE_KEY)).toEqual([CLAUDE]);

    // Later chats add to the live list.
    events.stream.emit(personasEvent([CODEX]));
    expect(directory.personas).toEqual([CLAUDE, CODEX]);
    directory.dispose();
  });

  it('forgets the remembered personas when the server offers none', async () => {
    const state = new StateDB();
    await state.save(PERSONAS_STATE_KEY, [CODEX]);
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events, state);
    await flush();
    expect(directory.personas).toEqual([CODEX]);

    // Every persona package was uninstalled: the first chat lists nobody.
    events.stream.emit(personasEvent([]));
    expect(directory.personas).toEqual([]);
    await flush();
    expect(await state.fetch(PERSONAS_STATE_KEY)).toEqual([]);

    // Once the list is live, an empty one from another chat removes nothing.
    events.stream.emit(personasEvent([CLAUDE]));
    events.stream.emit(personasEvent([]));
    expect(directory.personas).toEqual([CLAUDE]);
    directory.dispose();
  });

  it('ignores a remembered list that arrives after a live one', async () => {
    const state = new StateDB();
    await state.save(PERSONAS_STATE_KEY, [CODEX]);
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events, state);
    // The event arrives before the state database answers.
    events.stream.emit(personasEvent([CLAUDE]));
    await flush();
    expect(directory.personas).toEqual([CLAUDE]);
    directory.dispose();
  });
});
