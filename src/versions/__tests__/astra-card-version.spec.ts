import { parseAstraCard } from '../../astra-mime-data';
import { cardVersionState } from '../../astra-mime';
import type { IOutputVersion } from '../versions-api';

jest.mock('../../element-widget', () => ({ useProject: jest.fn() }));
jest.mock('../../project-renderers', () => ({
  useProjectRenderers: jest.fn()
}));

const card = {
  version: 1,
  entrypoint: 'project/astra.yaml',
  target: 'outputs.figure',
  universeId: null
};

test('accepts an optional output version and normalizes its commit', () => {
  expect(parseAstraCard(card).outputVersion).toBeUndefined();
  expect(
    parseAstraCard({ ...card, outputVersion: { commit: 'A889877' } })
      .outputVersion
  ).toEqual({ commit: 'a889877' });
  expect(
    parseAstraCard({
      ...card,
      outputVersion: {
        commit: 'a'.repeat(40),
        key: 'SHA256E-s1--x.png',
        extra: 1
      }
    }).outputVersion
  ).toEqual({ commit: 'a'.repeat(40), key: 'SHA256E-s1--x.png' });
});

test.each([
  { commit: 'abc' },
  { commit: 'g'.repeat(7) },
  { commit: 'a'.repeat(41) },
  { key: 'x' },
  { commit: 'a'.repeat(7), key: '' },
  { commit: 'a'.repeat(7), key: 'has space' },
  { commit: 'a'.repeat(7), key: 'a/b' },
  'a889877',
  null
])('rejects a malformed output version: %j', outputVersion => {
  expect(() => parseAstraCard({ ...card, outputVersion })).toThrow();
});

test('tells a card whether its version is the latest', () => {
  const version = (commit: string): IOutputVersion => ({
    commit,
    short: commit.slice(0, 7),
    time: '2026-09-20T10:00:00Z',
    subject: '',
    key: null,
    size: null,
    present: true,
    run: null,
    manifest: null
  });
  const history = [version('c'.repeat(40)), version('b'.repeat(40))];
  expect(cardVersionState({ commit: 'c'.repeat(7) }, undefined)).toBe(
    'unknown'
  );
  expect(cardVersionState({ commit: 'c'.repeat(7) }, history)).toBe('latest');
  expect(cardVersionState({ commit: 'b'.repeat(40) }, history)).toBe(
    'superseded'
  );
  expect(cardVersionState({ commit: 'a'.repeat(7) }, history)).toBe('missing');
  expect(cardVersionState({ commit: 'a'.repeat(7) }, [])).toBe('missing');
});
