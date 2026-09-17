import { parseRunRecord } from '../output-provenance';

const record = {
  schema_version: 1,
  finished_at: '2026-09-15T10:00:00Z',
  git_sha: 'abc123',
  recipe: 'python original.py',
  env_version: 'sha256:env',
  lc_version: '0.5',
  input_versions: { catalog: 'sha256:input' }
};

it('maps the recorded recipe and versions without substituting current definitions', () => {
  expect(parseRunRecord({ record })).toEqual({
    finishedAt: record.finished_at,
    gitRevision: record.git_sha,
    recipe: record.recipe,
    environment: record.env_version,
    cliVersion: record.lc_version,
    inputVersions: record.input_versions
  });
});

it('distinguishes no recorded run from an unsupported response', () => {
  expect(parseRunRecord({ record: null })).toBeNull();
  for (const payload of [
    null,
    {},
    { record: {} },
    { record: { ...record, schema_version: 2 } },
    { record: { ...record, input_versions: { catalog: {} } } }
  ]) {
    expect(() => parseRunRecord(payload)).toThrow('Unsupported run record');
  }
});
