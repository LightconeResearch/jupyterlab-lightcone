import {
  assembleLoadedProject,
  resolveProject,
  projectErrorMessage
} from '../project-data';
import { diffProjects, snapshotProject } from '../project-changes';
import { createContents, fileModel } from './project-fixtures';

const spec = `version: '0.0.14'
name: Project
inputs:
  - id: catalog
    type: data
    description: Original data
outputs:
  - id: fit
    type: metric
    format: json
decisions:
  range:
    label: Fitting range
    default: narrow
    options:
      narrow: '48–152'
      wide: '40–160'
prior_insights:
  source:
    claim: Earlier result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: paper
        doi: 10.1234/example
findings:
  result:
    claim: Our result
    created_at: '2026-01-01T00:00:00Z'
    evidence:
      - id: measurement
        artifact: fit
`;

async function snapshot(text = spec, artifacts: Record<string, string> = {}) {
  const { contents } = createContents({
    'astra.yaml': fileModel(text),
    ...Object.fromEntries(
      Object.entries(artifacts).map(([path, content]) => [
        path,
        fileModel(content)
      ])
    )
  });
  try {
    const resolved = await resolveProject(contents);
    return snapshotProject(assembleLoadedProject(resolved.bundle, {}));
  } catch (error) {
    throw new Error(projectErrorMessage(error));
  } finally {
    contents.dispose();
  }
}

it('ignores YAML formatting, field order, timestamps, and option order', async () => {
  const before = await snapshot();
  const after = await snapshot(
    spec
      .replace('name: Project', 'name: "Project" # comment')
      .replace('2026-01-01', '2026-02-01')
      .replace(
        "      narrow: '48–152'\n      wide: '40–160'",
        "      wide: '40–160'\n      narrow: '48–152'"
      )
  );
  expect(diffProjects(before, after)).toEqual([]);
});

it('reports selected decisions, inputs, outputs, findings, insights, and bibliography', async () => {
  const before = await snapshot();
  const after = await snapshot(
    spec
      .replace('default: narrow', 'default: wide')
      .replace('Original data', 'Revised source')
      .replace('type: metric', 'type: data')
      .replace('Earlier result', 'Revised prior result')
      .replace('Our result', 'Revised finding')
      .replace('10.1234/example', '10.1234/replacement')
  );
  const changes = diffProjects(before, after);
  expect(changes.map(item => [item.kind, item.action])).toEqual(
    expect.arrayContaining([
      ['decision', 'changed'],
      ['input', 'changed'],
      ['output', 'changed'],
      ['finding', 'changed'],
      ['insight', 'changed'],
      ['paper', 'added'],
      ['paper', 'removed']
    ])
  );
  expect(changes.find(item => item.kind === 'decision')?.detail).toBe(
    '48–152 → 40–160'
  );
  expect(changes.find(item => item.kind === 'input')?.reference).toEqual({
    kind: 'input',
    id: 'catalog',
    canonicalPath: 'inputs.catalog'
  });
});

it('reports hierarchy additions, removals, and renames without duplicating descendants on rename', async () => {
  const before = await snapshot(
    spec +
      '\nanalyses:\n  checks:\n    name: Checks\n    inputs: []\n    outputs: []\n'
  );
  const after = await snapshot(
    spec +
      '\nanalyses:\n  checks:\n    name: Validation\n    inputs: []\n    outputs: []\n'
  );
  expect(diffProjects(before, after)).toMatchObject([
    { kind: 'subanalysis', action: 'changed', label: 'Validation' }
  ]);
  expect(diffProjects(after, await snapshot())).toMatchObject([
    { kind: 'subanalysis', action: 'removed' }
  ]);
  expect(diffProjects(await snapshot(), before)).toMatchObject([
    { kind: 'subanalysis', action: 'added' }
  ]);
});

it('reports a finding whose evidence changes to another existing output', async () => {
  const original = spec.replace(
    'decisions:',
    '  - id: other\n    type: metric\n    format: json\ndecisions:'
  );
  const before = await snapshot(original);
  const after = await snapshot(
    original.replace('artifact: fit', 'artifact: other')
  );
  expect(diffProjects(before, after)).toMatchObject([
    { kind: 'finding', action: 'changed', detail: 'evidence' }
  ]);
});

it('does not report output definition changes when runtime artifact metadata changes', async () => {
  const before = await snapshot();
  const materialized = await snapshot(spec, {
    'results/default/fit.json': '{"value":42}'
  });
  expect(diffProjects(before, materialized)).toMatchObject([
    { kind: 'result', action: 'ready' }
  ]);
  const rewritten = await snapshot(spec, {
    'results/default/fit.json': '{"value":4200}'
  });
  expect(diffProjects(materialized, rewritten)).toEqual([]);
});

it('separates artifact availability from definitions, and requires content hashes for reruns', async () => {
  const before = await snapshot();
  const after = await snapshot();
  const result = {
    token: 'first',
    path: 'results/default/fit.json',
    hash: 'sha256:one'
  };
  after.results.set('outputs.fit', result);
  expect(diffProjects(before, after)).toMatchObject([
    { kind: 'result', action: 'ready' }
  ]);
  const touched = await snapshot();
  touched.results.set('outputs.fit', { ...result, token: 'touched' });
  expect(diffProjects(after, touched)).toEqual([]);
  touched.results.set('outputs.fit', {
    ...result,
    token: 'rewritten',
    hash: 'sha256:two'
  });
  expect(diffProjects(after, touched)).toMatchObject([
    { kind: 'result', action: 'updated' }
  ]);
  touched.results.set('outputs.fit', {
    ...result,
    token: 'unsupported-drive',
    hash: undefined
  });
  expect(diffProjects(after, touched)).toEqual([]);
});
