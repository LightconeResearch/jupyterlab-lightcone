import { assembleLoadedProject, resolveProject } from '../project-data';
import {
  parseElementReference,
  resolveElement,
  resolveReference
} from '../element-reference';
import { createContents, fileModel } from './project-fixtures';

const yaml = `version: "0.0.14"
name: References
inputs: []
outputs: []
decisions:
  method:
    label: Estimator
    options:
      robust:
        label: Robust
    default: robust
prior_insights:
  precedent:
    claim: A cited result.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: 10.1234/example
`;

test('validates project paths without discarding Jupyter Contents drive prefixes', () => {
  expect(
    parseElementReference({
      entrypoint: 'drive:project/astra.yaml',
      target: 'decisions.method'
    }).entrypoint
  ).toBe('drive:project/astra.yaml');
  for (const entrypoint of ['../astra.yaml', '/astra.yaml', 'other.yaml'])
    expect(() =>
      parseElementReference({ entrypoint, target: 'outputs.fit' })
    ).toThrow();
});

test('resolves exact records, owning records for children, scopes and cited papers', async () => {
  const { contents } = createContents({
    'astra.yaml': fileModel(
      yaml + '\nanalyses:\n  child:\n    path: ./analyses/child\n'
    ),
    'analyses/child/astra.yaml': fileModel(yaml)
  });
  try {
    const { bundle } = await resolveProject(contents);
    const data = assembleLoadedProject(bundle, {});
    expect(resolveElement(data, 'decisions.method.robust').target).toBe(
      'decisions.method'
    );
    expect(resolveElement(data, 'decisions.method.options.robust').target).toBe(
      'decisions.method'
    );
    expect(resolveElement(data, 'child.decisions.method').target).toBe(
      'child.decisions.method'
    );
    expect(
      resolveElement(data, 'analyses.child.outputs').analysis.canonicalPath
    ).toBe('child');
    expect(() => resolveElement(data, 'decisions.method.missing')).toThrow(
      'TARGET_NOT_FOUND'
    );
    expect(() => resolveElement(data, 'decisions.missing')).toThrow(
      'TARGET_NOT_FOUND'
    );
    expect(
      resolveReference(data, {
        entrypoint: 'astra.yaml',
        target: '',
        doi: '10.1234/example'
      }).paper?.doi
    ).toBe('10.1234/example');
    expect(() =>
      resolveReference(data, {
        entrypoint: 'astra.yaml',
        target: '',
        doi: '10.1234/missing'
      })
    ).toThrow('not cited');
  } finally {
    contents.dispose();
  }
});
