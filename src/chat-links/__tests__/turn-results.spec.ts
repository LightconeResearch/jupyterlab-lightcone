import type { IRunRecord } from '../../runs/runs-api';
import {
  filesEditedIn,
  isAgentMessage,
  materializedDuring,
  toolCallDiffPaths,
  turnEndingAt,
  type ITurnMessage
} from '../turn-results';

const USER = { username: 'ada' };
const AGENT = { username: 'jupyter-ai-personas::pkg::Lightcone', bot: true };

function message(
  id: string,
  time: number,
  sender: ITurnMessage['sender'],
  extra: Partial<ITurnMessage> = {}
): ITurnMessage {
  return { id, time, sender, ...extra };
}

function run(
  time: string,
  output: string,
  universe = 'baseline',
  exit: number | null = 0
): IRunRecord {
  return {
    commit: `${output}-${time}`,
    short: 'abc1234',
    time,
    output,
    universe,
    exit,
    cmd: 'lc materialize',
    inputs: [],
    outputs: [`results/${universe}/${output}.png`]
  };
}

describe('isAgentMessage', () => {
  it('recognises personas by flag or id prefix', () => {
    expect(isAgentMessage({ sender: AGENT })).toBe(true);
    expect(isAgentMessage({ sender: { username: AGENT.username } })).toBe(true);
    expect(isAgentMessage({ sender: { username: 'bot', bot: true } })).toBe(
      true
    );
    expect(isAgentMessage({ sender: USER })).toBe(false);
  });
});

describe('turnEndingAt', () => {
  const chat = [
    message('u1', 100.4, USER),
    message('a1', 101, AGENT),
    message('a2', 130.2, AGENT),
    message('u2', 200, USER),
    message('a3', 205, AGENT)
  ];

  it('finds the turn whose last agent message is the given one', () => {
    expect(turnEndingAt(chat, 'a2')).toEqual({
      userMessageId: 'u1',
      start: 100.4,
      end: 130.2,
      agentMessageIds: ['a1', 'a2']
    });
    expect(turnEndingAt(chat, 'a3')).toEqual({
      userMessageId: 'u2',
      start: 200,
      end: 205,
      agentMessageIds: ['a3']
    });
  });

  it('answers nothing for user messages and earlier agent messages', () => {
    expect(turnEndingAt(chat, 'u1')).toBeUndefined();
    expect(turnEndingAt(chat, 'a1')).toBeUndefined();
    expect(turnEndingAt(chat, 'missing')).toBeUndefined();
  });

  it('needs a user message before the reply', () => {
    expect(turnEndingAt([message('a0', 1, AGENT)], 'a0')).toBeUndefined();
  });

  it('orders by time and ignores deleted messages', () => {
    const shuffled = [chat[4], chat[1], chat[3], chat[0], chat[2]];
    expect(turnEndingAt(shuffled, 'a2')?.agentMessageIds).toEqual(['a1', 'a2']);
    const withDeleted = [
      ...chat.slice(0, 3),
      message('u-deleted', 150, USER, { deleted: true }),
      message('a-deleted', 160, AGENT, { deleted: true }),
      ...chat.slice(3)
    ];
    expect(turnEndingAt(withDeleted, 'a2')).toEqual(turnEndingAt(chat, 'a2'));
    expect(turnEndingAt(withDeleted, 'a-deleted')).toBeUndefined();
  });
});

describe('materializedDuring', () => {
  const window = { start: 1000.6, end: 1100.2 };

  it('keeps runs committed inside the window, widened to whole seconds', () => {
    const runs = [
      run('1970-01-01T00:16:40Z', 'edge_start'),
      run('1970-01-01T00:17:00Z', 'inside'),
      run('1970-01-01T00:18:21Z', 'edge_end'),
      run('1970-01-01T00:16:39Z', 'before'),
      run('1970-01-01T00:18:22Z', 'after')
    ];
    expect(materializedDuring(runs, window).map(item => item.output)).toEqual([
      'edge_start',
      'inside',
      'edge_end'
    ]);
  });

  it('collapses redraws to the newest commit per output and universe', () => {
    const runs = [
      run('1970-01-01T00:17:30Z', 'hubble'),
      run('1970-01-01T00:17:00Z', 'hubble'),
      run('1970-01-01T00:17:10Z', 'hubble', 'alt'),
      run('1970-01-01T00:17:05Z', 'table')
    ];
    const items = materializedDuring(runs, window);
    expect(
      items.map(item => [item.universe, item.output, item.run.time])
    ).toEqual([
      ['baseline', 'table', '1970-01-01T00:17:05Z'],
      ['alt', 'hubble', '1970-01-01T00:17:10Z'],
      ['baseline', 'hubble', '1970-01-01T00:17:30Z']
    ]);
  });

  it('skips failed runs and unreadable times', () => {
    const runs = [
      run('1970-01-01T00:17:00Z', 'failed', 'baseline', 1),
      run('not a date', 'unreadable'),
      run('1970-01-01T00:17:00Z', 'unknown_exit', 'baseline', null)
    ];
    expect(materializedDuring(runs, window).map(item => item.output)).toEqual([
      'unknown_exit'
    ]);
  });
});

describe('files edited', () => {
  const metadata = {
    tool_calls: [
      {
        tool_call_id: '1',
        title: 'Edit',
        diffs: [
          { path: '/srv/p/src/a.py', new_text: 'x' },
          { path: '/srv/p/src/b.py', new_text: 'y' }
        ]
      },
      { tool_call_id: '2', title: 'Read', locations: ['/srv/p/README.md'] },
      { tool_call_id: '3', diffs: [{ path: '/srv/p/src/a.py', new_text: 'z' }] }
    ]
  };

  it('reads diff paths from ACP tool calls only', () => {
    expect(toolCallDiffPaths(metadata)).toEqual([
      '/srv/p/src/a.py',
      '/srv/p/src/b.py',
      '/srv/p/src/a.py'
    ]);
    expect(toolCallDiffPaths(undefined)).toEqual([]);
    expect(toolCallDiffPaths({ tool_calls: 'nope' })).toEqual([]);
    expect(
      toolCallDiffPaths({ tool_calls: [{ diffs: [{ path: 3 }] }] })
    ).toEqual([]);
  });

  it('collects the turn agent messages in order without repeats', () => {
    const chat = [
      message('u1', 1, USER),
      message('a1', 2, AGENT, { metadata }),
      message('a2', 3, AGENT, {
        metadata: {
          tool_calls: [{ diffs: [{ path: '/srv/p/src/c.py', new_text: '' }] }]
        }
      }),
      message('u2', 4, USER),
      message('a3', 5, AGENT, {
        metadata: {
          tool_calls: [{ diffs: [{ path: '/srv/p/other.py', new_text: '' }] }]
        }
      })
    ];
    expect(filesEditedIn(chat, turnEndingAt(chat, 'a2')!)).toEqual([
      '/srv/p/src/a.py',
      '/srv/p/src/b.py',
      '/srv/p/src/c.py'
    ]);
    expect(filesEditedIn(chat, turnEndingAt(chat, 'a3')!)).toEqual([
      '/srv/p/other.py'
    ]);
  });
});
