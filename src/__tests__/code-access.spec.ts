import { assembleLoadedProject, resolveProject } from '../project-data';
import { resolveOutputCode, scriptFromCommand } from '../code-access';
import { createContents, fileModel } from './project-fixtures';

it.each([
  ['python src/plot.py --out result.png', 'src/plot.py'],
  ['uv run python3 "src/plot file.py" --out result.png', 'src/plot file.py'],
  ['./src/plot.sh', 'src/plot.sh'],
  ['python -m module', undefined],
  ['python -c "print(1)"', undefined],
  ['python {inputs.script}', undefined],
  ['python ../outside.py', undefined],
  ['python /absolute/script.py', undefined],
  ['python src/a.py | python src/b.py', undefined],
  ['python "$SCRIPT"', undefined],
  ['cd other && python src/a.py', undefined]
])('recognizes only direct local scripts: %s', (command, expected) => {
  expect(scriptFromCommand(command)).toBe(expected);
});

it.each([
  ['python {inputs.script}', 'src/declared.py'],
  ['uv run python3 {inputs.script} --out result.png', 'src/declared.py'],
  ['python {inputs.missing}', undefined],
  ['python {inputs.absolute}', undefined],
  ['python {outputs.script}', undefined]
])('resolves a declared script placeholder: %s', (command, expected) => {
  const sources = new Map([
    ['script', 'src/declared.py'],
    ['absolute', '/etc/passwd']
  ]);
  expect(scriptFromCommand(command, sources)).toBe(expected);
});

it('prefers the recorded command, supports quoted paths, and checks existence', async () => {
  const project = `version: '0.0.14'\nname: Code preview\ninputs: []\noutputs:\n  - id: plot\n    type: figure\n    format: png\n    recipe:\n      command: python src/current.py\n`;
  const { contents } = createContents({
    'work/astra.yaml': fileModel(project),
    'work/src/current.py': fileModel('# current'),
    'work/src/recorded script.py': fileModel('# recorded')
  });
  try {
    const { bundle } = await resolveProject(contents, 'work/astra.yaml');
    const data = assembleLoadedProject(bundle, {});
    const output = data.document.analysis.outputs[0];
    const resolve = (recorded?: string) =>
      resolveOutputCode(contents, 'work/astra.yaml', data, output, recorded);
    expect(
      await resolve('python "src/recorded script.py" --out results/plot.png')
    ).toEqual({
      path: 'work/src/recorded script.py',
      relativePath: 'src/recorded script.py',
      source: 'recorded run'
    });
    expect(await resolve()).toEqual({
      path: 'work/src/current.py',
      relativePath: 'src/current.py',
      source: 'declared recipe'
    });
    // A recorded run names what actually ran; do not substitute the declaration.
    expect(await resolve('python src/missing.py')).toBeUndefined();
  } finally {
    contents.dispose();
  }
});

it('opens the script a recipe names through an input, with no recorded run', async () => {
  const project = `version: '0.0.14'\nname: Code preview\ninputs:\n  - id: extract_script\n    type: data\n    source: src/extract_metric.py\noutputs:\n  - id: metric\n    type: metric\n    format: json\n    inputs:\n      - extract_script\n    recipe:\n      command: python {inputs.extract_script} --out {output}\n`;
  const { contents } = createContents({
    'work/astra.yaml': fileModel(project),
    'work/src/extract_metric.py': fileModel('# extract')
  });
  try {
    const { bundle } = await resolveProject(contents, 'work/astra.yaml');
    const data = assembleLoadedProject(bundle, {});
    const output = data.document.analysis.outputs[0];
    expect(
      await resolveOutputCode(contents, 'work/astra.yaml', data, output)
    ).toEqual({
      path: 'work/src/extract_metric.py',
      relativePath: 'src/extract_metric.py',
      source: 'declared recipe'
    });
  } finally {
    contents.dispose();
  }
});
