import { ContentsManager, ServerConnection } from '@jupyterlab/services';
import {
  sessionStem,
  slugForTitle,
  titleForSession,
  titleFromMessage,
  uniqueSessionName
} from '../session-titles';
import { fileModel } from '../../__tests__/project-fixtures';

describe('slugForTitle', () => {
  it('lowercases, joins runs of punctuation and trims dashes', () => {
    expect(slugForTitle('Hubble diagram, with error bars!')).toBe(
      'hubble-diagram-with-error-bars'
    );
    expect(slugForTitle('  --Contour   styling--  ')).toBe('contour-styling');
  });

  it('falls back to untitled and never ends with a dash after cutting', () => {
    expect(slugForTitle('')).toBe('untitled');
    expect(slugForTitle('¿?¡!')).toBe('untitled');
    const long = slugForTitle('a'.repeat(47) + ' ' + 'b'.repeat(20));
    expect(long).toBe('a'.repeat(47));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(slugForTitle('x'.repeat(60)).length).toBe(48);
  });
});

describe('titleFromMessage', () => {
  it('takes the first non-empty line', () => {
    expect(titleFromMessage('\n\n  Plot the Hubble diagram  \nwith bars')).toBe(
      'Plot the Hubble diagram'
    );
    expect(titleFromMessage('\r\n\u2028Fit the model\rthen plot')).toBe(
      'Fit the model'
    );
    expect(titleFromMessage('   ')).toBe('');
  });

  it('shortens long lines the way the server titles stored chats', () => {
    // `session_title` in sessions.py: the first 79 characters, trimmed, and `…`.
    const exact = 'x'.repeat(80);
    expect(titleFromMessage(exact)).toBe(exact);
    expect(titleFromMessage('word '.repeat(30))).toBe(
      `${'word '.repeat(16).trimEnd()}…`
    );
    expect(titleFromMessage(`${'y'.repeat(78)} z tail`)).toBe(
      `${'y'.repeat(78)}…`
    );
    // Characters, not UTF-16 units, as Python counts them.
    const stars = '✨'.repeat(40) + '🔭'.repeat(40);
    expect(titleFromMessage(stars)).toBe(stars);
    expect(Array.from(titleFromMessage(`${stars}!`))).toHaveLength(80);
  });
});

describe('titleForSession', () => {
  it('prefers the stored title and otherwise reads the file stem', () => {
    expect(
      titleForSession({ path: 'p/chats/x.chat', title: ' Hubble diagram ' })
    ).toBe('Hubble diagram');
    expect(
      titleForSession({ path: 'p/chats/hubble_diagram-v2.chat', title: '' })
    ).toBe('hubble diagram v2');
    expect(titleForSession({ path: 'p/untitled.chat', title: '' })).toBe(
      'untitled'
    );
    expect(titleForSession({ path: 'drive:untitled3.chat', title: '' })).toBe(
      'untitled3'
    );
  });

  it('strips directories, drives and extensions from stems', () => {
    expect(sessionStem('RTC:project/chats/plan.chat')).toBe('plan');
    expect(sessionStem('archive:old.chat')).toBe('old');
    expect(sessionStem('plan')).toBe('plan');
  });

  it('keeps colons in the names of chats inside folders', () => {
    // Only the first segment of a path can name a drive.
    expect(sessionStem('p/chats/q: fit the model.chat')).toBe(
      'q: fit the model'
    );
    expect(sessionStem('RTC:p/chats/a:b.chat')).toBe('a:b');
    expect(
      titleForSession({ path: 'p/chats/q: fit the model.chat', title: '' })
    ).toBe('q: fit the model');
  });
});

describe('uniqueSessionName', () => {
  it('appends a counter while the chat file exists', async () => {
    const contents = new ContentsManager();
    const existing = new Set(['p/chats/plan.chat', 'p/chats/plan-2.chat']);
    jest.spyOn(contents, 'get').mockImplementation(async path => {
      if (!existing.has(path)) {
        throw new ServerConnection.ResponseError(
          new Response('', { status: 404 })
        );
      }
      return fileModel('', { path });
    });
    try {
      expect(await uniqueSessionName(contents, 'p/chats', 'plan')).toBe(
        'plan-3'
      );
      expect(await uniqueSessionName(contents, 'p/chats', 'fresh')).toBe(
        'fresh'
      );
    } finally {
      contents.dispose();
    }
  });
});
