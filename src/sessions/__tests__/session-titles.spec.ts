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
  it('takes the first non-empty line, trimmed to 80 characters', () => {
    expect(titleFromMessage('\n\n  Plot the Hubble diagram  \nwith bars')).toBe(
      'Plot the Hubble diagram'
    );
    const long = 'word '.repeat(30);
    expect(titleFromMessage(long).length).toBeLessThanOrEqual(80);
    expect(titleFromMessage(long).endsWith(' ')).toBe(false);
    expect(titleFromMessage('   ')).toBe('');
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

  it('strips drives and extensions from stems', () => {
    expect(sessionStem('RTC:project/chats/plan.chat')).toBe('plan');
    expect(sessionStem('plan')).toBe('plan');
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
