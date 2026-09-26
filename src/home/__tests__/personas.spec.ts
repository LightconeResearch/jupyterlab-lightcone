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
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces valid lists and also reports removals and repeated ids', () => {
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events);
    const changed = jest.fn();
    directory.changed.connect(changed);
    try {
      events.stream.emit(personasEvent([CODEX]));
      events.stream.emit(personasEvent([CODEX, CLAUDE]));
      jest.advanceTimersByTime(100);
      expect(changed).toHaveBeenCalledTimes(1);
      events.stream.emit(personasEvent([]));
      jest.advanceTimersByTime(100);
      expect(changed).toHaveBeenCalledTimes(2);
      events.stream.emit(personasEvent([CODEX]));
      jest.advanceTimersByTime(100);
      events.stream.emit(personasEvent([CODEX]));
      jest.advanceTimersByTime(100);
      expect(changed).toHaveBeenCalledTimes(4);
    } finally {
      directory.dispose();
    }
  });

  it('ignores other or malformed events and cancels notification on disposal', () => {
    const events = new FakeEvents();
    const directory = new PersonaDirectory(events);
    const changed = jest.fn();
    directory.changed.connect(changed);
    events.stream.emit({
      schema_id: 'https://example.org/other',
      personas: []
    });
    events.stream.emit({ ...personasEvent([]), personas: [{ name: 'No id' }] });
    jest.advanceTimersByTime(100);
    expect(changed).not.toHaveBeenCalled();
    events.stream.emit(personasEvent([CODEX]));
    directory.dispose();
    jest.advanceTimersByTime(100);
    events.stream.emit(personasEvent([CLAUDE]));
    jest.advanceTimersByTime(100);
    expect(changed).not.toHaveBeenCalled();
  });
});
