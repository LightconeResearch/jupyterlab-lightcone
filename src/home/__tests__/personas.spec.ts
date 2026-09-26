import { PersonaDirectory } from '../personas';
import { FakeEvents, personasEvent } from './home-fixtures';

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
});
