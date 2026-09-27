import { renamedSessionPath } from '../session-rename';

describe('renamedSessionPath', () => {
  it('slugs the name in the same folder and drive', () => {
    expect(
      renamedSessionPath('project/chats/untitled-2.chat', 'Hubble fit, v2')
    ).toBe('project/chats/hubble-fit-v2.chat');
    expect(renamedSessionPath('project/chats/a.chat', ' Final.CHAT ')).toBe(
      'project/chats/final.chat'
    );
    expect(renamedSessionPath('archive:old.chat', 'New')).toBe(
      'archive:new.chat'
    );
    expect(renamedSessionPath('old.chat', 'new.chat')).toBe('new.chat');
  });

  it('changes nothing for a blank or identical name', () => {
    expect(renamedSessionPath('project/chats/a.chat', '   ')).toBeUndefined();
    expect(renamedSessionPath('project/chats/a.chat', '.chat')).toBeUndefined();
    expect(renamedSessionPath('project/chats/a.chat', 'A')).toBeUndefined();
    // Accepting the dialog's text unchanged keeps a name that is not a slug.
    expect(
      renamedSessionPath('project/chats/Hubble Fit.chat', 'Hubble Fit')
    ).toBeUndefined();
    expect(
      renamedSessionPath('project/chats/Hubble Fit.chat', 'Hubble Fit v2')
    ).toBe('project/chats/hubble-fit-v2.chat');
  });
});
