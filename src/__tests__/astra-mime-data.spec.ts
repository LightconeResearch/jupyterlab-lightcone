import { parseAstraCard } from '../astra-mime-data';

const card = {
  version: 1,
  entrypoint: 'project/astra.yaml',
  target: 'outputs.figure',
  universeId: null
};

test('preserves a pinned reference and discards unrelated fields', () => {
  expect(parseAstraCard({ ...card, html: '<script>bad()</script>' })).toEqual(
    card
  );
  expect(parseAstraCard({ ...card, universeId: 'baseline' }).universeId).toBe(
    'baseline'
  );
});

test.each([
  null,
  { ...card, version: 2 },
  { ...card, universeId: undefined },
  { ...card, universeId: {} },
  { ...card, entrypoint: '../astra.yaml' },
  { ...card, entrypoint: 'https://example.org/astra.yaml' },
  { ...card, target: 'x'.repeat(1025) },
  { ...card, doi: '10.1234/paper' }
])('rejects malformed, unpinned or unsupported data: %j', value => {
  expect(() => parseAstraCard(value)).toThrow();
});
