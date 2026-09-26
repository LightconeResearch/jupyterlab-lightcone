import {
  readAgentModes,
  readToolCalls,
  MODE_SETTING_ID
} from '../acp-metadata';

const CODEX = 'jupyter-ai-personas::acp::Codex';
const CLAUDE = 'jupyter-ai-personas::acp::Claude';

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

describe('readAgentModes', () => {
  it('reads the mode config choice, else the mode of an agent without one', () => {
    expect(
      readAgentModes({
        acp_modes: { [CLAUDE]: 'plan', [CODEX]: 'stale', broken: 3 },
        acp_config_options: {
          [CODEX]: { mode: 'agent-full-access', model: 'gpt' },
          empty: {},
          typo: { mode: 3 }
        }
      })
    ).toEqual([
      { persona: CLAUDE, mode: 'plan' },
      { persona: CODEX, mode: 'agent-full-access' }
    ]);
    expect(readAgentModes(null)).toEqual([]);
    expect(readAgentModes({ acp_config_options: 'x', acp_modes: [] })).toEqual(
      []
    );
  });

  it('names the setting the persona manager publishes modes under', () => {
    expect(MODE_SETTING_ID).toBe('__mode__');
  });
});
