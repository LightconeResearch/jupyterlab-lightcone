import type { ResolvedRecord } from '@astra-spec/sdk';
import type { IInputModel } from '@jupyter/chat';
import type { Contents } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { IChatProjectResolver } from '../../chat-links/chat-project';
import { acquireProjectDataService } from '../../project-data-service';
import type { ISessionService } from '../../sessions/session-service';
import type { ISessionInfo } from '../../sessions/sessions-api';
import { listVersionsCached } from '../../versions/version-cache';
import {
  matchRank,
  MentionProvider,
  parseMention,
  recordMentions,
  sessionMentions
} from '../index';
import { withLightconeServer } from '../../__tests__/server-fixtures';

// These behaviors belong to the full install, with Lightcone's server routes.
withLightconeServer();

jest.mock('@jupyter/chat', () => {
  const { Token } = jest.requireActual('@lumino/coreutils');
  return {
    chatIcon: { name: 'chat' },
    IChatCommandRegistry: new Token('@jupyter/chat:commands')
  };
});
jest.mock('../../project-data-service', () => ({
  acquireProjectDataService: jest.fn()
}));
jest.mock('../../versions/version-cache', () => ({
  listVersionsCached: jest.fn()
}));

function record(
  kind: ResolvedRecord['kind'],
  id: string,
  label?: string,
  scope = ''
): ResolvedRecord {
  const collection = {
    output: 'outputs',
    decision: 'decisions',
    input: 'inputs',
    finding: 'findings',
    prior_insight: 'prior_insights'
  }[kind];
  return {
    kind,
    id,
    label,
    canonicalPath: `${scope}${collection}.${id}`
  } as unknown as ResolvedRecord;
}

const records = [
  record('output', 'hubble_diagram', 'Hubble diagram'),
  record('decision', 'cosmological_model', 'Cosmological model'),
  record('input', 'supernovae', 'Union 2.1 supernovae'),
  record('output', 'hubble_residuals', undefined, 'sub.')
];

function session(path: string, title: string): ISessionInfo {
  return {
    path,
    title,
    modified: '2026-09-20T10:00:00Z',
    messages: 2,
    lastAgent: null,
    activity: 'idle'
  };
}

describe('mention parsing and ranking', () => {
  it('recognizes @ and # words, but not a bare heading mark', () => {
    expect(parseMention('@Hub')).toEqual({ trigger: '@', query: 'hub' });
    expect(parseMention('@')).toEqual({ trigger: '@', query: '' });
    expect(parseMention('#fit')).toEqual({ trigger: '#', query: 'fit' });
    expect(parseMention('#')).toBeNull();
    expect(parseMention('hello')).toBeNull();
    expect(parseMention(null)).toBeNull();
  });

  it('ranks identifier prefixes before path prefixes and inner matches', () => {
    expect(matchRank('hub', 'hubble', 'outputs.hubble', 'Hubble')).toBe(0);
    expect(matchRank('outputs.h', 'hubble', 'outputs.hubble', 'H')).toBe(1);
    expect(matchRank('diagram', 'hubble', 'outputs.hubble', 'Diagram')).toBe(2);
    expect(matchRank('zzz', 'hubble', 'outputs.hubble', 'Hubble')).toBeNull();
  });
});

describe('record mentions', () => {
  it('insert the canonical path, with the output version when known', () => {
    const mentions = recordMentions(records, 'hub', item =>
      item.id === 'hubble_diagram' ? 'a889877deadbeef' : undefined
    );
    expect(mentions.map(item => item.name)).toEqual([
      '@outputs.hubble_diagram',
      '@sub.outputs.hubble_residuals'
    ]);
    expect(mentions[0]).toEqual({
      name: '@outputs.hubble_diagram',
      description: 'Result · Hubble diagram',
      replaceWith: '`outputs.hubble_diagram` (version a889877)',
      kind: 'output'
    });
    expect(mentions[1].replaceWith).toBe('`sub.outputs.hubble_residuals`');
    const decision = recordMentions(records, 'model')[0];
    expect(decision.replaceWith).toBe('`decisions.cosmological_model`');
    expect(recordMentions(records, '', undefined, 2)).toHaveLength(2);
  });
});

describe('session mentions', () => {
  it('insert the chat file relative to the project', () => {
    const sessions = [
      session('proj/chats/hubble-fit.chat', 'Hubble fit'),
      session('proj/chats/contours.chat', 'Contour styling')
    ];
    expect(sessionMentions(sessions, 'hub', 'proj')).toEqual([
      {
        name: '#hubble-fit',
        description: 'Session · Hubble fit',
        replaceWith: '`chats/hubble-fit.chat`'
      }
    ]);
    expect(sessionMentions(sessions, 'styling', 'proj')[0].name).toBe(
      '#contours'
    );
  });
});

describe('MentionProvider', () => {
  const settings = ServerConnection.makeSettings();
  const contents = {
    serverSettings: settings,
    driveName: () => ''
  } as unknown as Contents.IManager;
  const projects: IChatProjectResolver = {
    resolve: async path =>
      path.startsWith('proj/')
        ? { path: 'proj', entrypoint: 'proj/astra.yaml' }
        : undefined
  };
  const data = {
    document: { universe: { universeId: 'baseline' } },
    index: {
      recordByPath: new Map(records.map(item => [item.canonicalPath, item])),
      analysisByRecordPath: new Map(
        records.map(item => [
          item.canonicalPath,
          {
            canonicalPath: item.canonicalPath.startsWith('sub.') ? 'sub' : '$'
          }
        ])
      )
    }
  };
  const release = jest.fn();

  beforeEach(() => {
    release.mockReset();
    jest.mocked(acquireProjectDataService).mockReturnValue({
      service: { get: async () => data },
      release
    } as unknown as ReturnType<typeof acquireProjectDataService>);
    jest.mocked(listVersionsCached).mockResolvedValue({
      file: 'results/baseline/hubble_diagram.png',
      annex: 'initialized',
      versions: [
        {
          commit: 'a889877' + '0'.repeat(33),
          short: 'a889877',
          time: '2026-09-20T10:00:00Z',
          subject: '',
          size: null,
          present: true,
          annex: null,
          manifest: null
        }
      ]
    });
  });

  function input(word: string, name = 'proj/chats/talk.chat'): IInputModel {
    return {
      currentWord: word,
      chatContext: { name }
    } as unknown as IInputModel;
  }

  it('completes records of the chat’s project with their pinned version', async () => {
    const provider = new MentionProvider({
      contents,
      sessions: null,
      projects
    });
    const completions = await provider.listCommandCompletions(input('@hub'));
    expect(completions[0]).toMatchObject({
      name: '@outputs.hubble_diagram',
      replaceWith: '`outputs.hubble_diagram` (version a889877)',
      spaceOnAccept: true,
      providerId: 'jupyterlab_lightcone:mentions'
    });
    // A sub-analysis output has no committed versions to name.
    expect(completions[1].replaceWith).toBe('`sub.outputs.hubble_residuals`');
    // Each record is listed behind the kind mark the inventory draws.
    const icon = completions[0].icon;
    expect(isValidElement(icon)).toBe(true);
    const node = document.createElement('div');
    const root = createRoot(node);
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    try {
      act(() => root.render(isValidElement(icon) ? icon : null));
      expect(
        node
          .querySelector('.lightcone-brand.astra-ui > .astra-kind-glyph')
          ?.getAttribute('data-kind')
      ).toBe('output');
      act(() => root.unmount());
    } finally {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
    }
    expect(listVersionsCached).toHaveBeenCalledTimes(1);
    expect(
      await provider.listCommandCompletions(input('@hub', 'loose/talk.chat'))
    ).toEqual([]);
    expect(await provider.listCommandCompletions(input('plain'))).toEqual([]);
    provider.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('completes sessions with #, and nothing without the sessions service', async () => {
    const sessions = {
      list: jest.fn(async () => [
        session('proj/chats/hubble-fit.chat', 'Hubble fit')
      ])
    } as unknown as ISessionService;
    const provider = new MentionProvider({ contents, sessions, projects });
    const completions = await provider.listCommandCompletions(input('#hub'));
    expect(completions.map(item => item.replaceWith)).toEqual([
      '`chats/hubble-fit.chat`'
    ]);
    // Sessions are not ASTRA records: they keep the chat icon.
    expect(completions[0].icon).toEqual({ name: 'chat' });
    const without = new MentionProvider({ contents, sessions: null, projects });
    expect(await without.listCommandCompletions(input('#hub'))).toEqual([]);
    provider.dispose();
    without.dispose();
  });
});
