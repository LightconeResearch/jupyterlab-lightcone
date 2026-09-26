import { readToolCalls } from '../acp-metadata';

describe('readToolCalls', () => {
  it('reads only well-formed tool calls, with the paths of their diffs', () => {
    expect(readToolCalls(undefined)).toEqual([]);
    expect(readToolCalls({ tool_calls: 'nope' })).toEqual([]);
    expect(
      readToolCalls({
        tool_calls: [
          {
            status: 'in_progress',
            permission_status: 'pending',
            diffs: [
              { path: '/srv/p/src/a.py', new_text: 'x' },
              { path: 3 },
              { path: '/srv/p/src/b.py', new_text: 'y' }
            ]
          },
          'junk',
          { status: 7, locations: ['/srv/p/README.md'] }
        ]
      })
    ).toEqual([
      {
        status: 'in_progress',
        permissionStatus: 'pending',
        diffPaths: ['/srv/p/src/a.py', '/srv/p/src/b.py']
      },
      { status: null, permissionStatus: null, diffPaths: [] }
    ]);
    expect(readToolCalls({ tool_calls: [{ diffs: 'nope' }] })).toEqual([
      { status: null, permissionStatus: null, diffPaths: [] }
    ]);
  });
});
