import { assembleLoadedProject, resolveProject } from '../project-data';
import { resolveOutputCode, scriptFromCommand } from '../code-access';
import { createContents, fileModel } from './project-fixtures';

it.each([
  ['python src/plot.py --out result.png', 'src/plot.py'],
  ['uv run python3 "src/plot file.py" --out result.png', 'src/plot file.py'],
  ['./src/plot.sh', 'src/plot.sh'],
  ['python src/metric.py > results/metric.json', 'src/metric.py'],
  ['python src/a.py >> run.log 2>&1', 'src/a.py'],
  ['python src/a.py # note', 'src/a.py'],
  ['python src/a.py --glob *.csv', 'src/a.py'],
  ['python -u src/train.py', 'src/train.py'],
  ['python -W ignore src/plot.py', 'src/plot.py'],
  ['python -- src/plot.py', 'src/plot.py'],
  ['Rscript --vanilla src/fit.R', 'src/fit.R'],
  ['bash -e scripts/run.sh', 'scripts/run.sh'],
  ['uv run --with numpy python src/a.py', 'src/a.py'],
  ['python -m module', undefined],
  ['python -um module src/a.py', undefined],
  ['python -c "import a" src/a.py', undefined],
  ['python - src/a.py', undefined],
  ['python -u run src/a.py', undefined],
  ['node -e "run()" src/a.js', undefined],
  ['bash -c src/a.sh', undefined],
  ['uv run --directory other python src/a.py', undefined],
  ['python src/*.py', undefined],
  ['python < src/a.py', undefined],
  ['python src/a.py && python src/b.py', undefined],
  ['python src/a.py; python src/b.py', undefined],
  ['python src/a.py &', undefined],
  ['(python src/a.py)', undefined],
  ['python ../outside.py', undefined],
  ['python /absolute/script.py', undefined],
  ['python src/a.py | python src/b.py', undefined],
  ['python "$SCRIPT"', undefined]
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
    const { index, document } = assembleLoadedProject(bundle, {});
    const output = document.analysis.outputs[0];
    const resolve = (recorded?: string) =>
      resolveOutputCode(contents, 'work/astra.yaml', index, output, recorded);
    expect(
      await resolve('python "src/recorded script.py" --out results/plot.png')
    ).toEqual({
      relativePath: 'src/recorded script.py',
      source: 'recorded run'
    });
    expect(await resolve()).toEqual({
      relativePath: 'src/current.py',
      source: 'declared recipe'
    });
    // A recorded run names what actually ran; do not substitute the declaration.
    expect(await resolve('python src/missing.py')).toBeUndefined();
    // An empty recorded recipe names nothing, the same as no record.
    expect(await resolve('')).toEqual({
      relativePath: 'src/current.py',
      source: 'declared recipe'
    });
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
    const { index, document } = assembleLoadedProject(bundle, {});
    const output = document.analysis.outputs[0];
    expect(
      await resolveOutputCode(contents, 'work/astra.yaml', index, output)
    ).toEqual({
      relativePath: 'src/extract_metric.py',
      source: 'declared recipe'
    });
  } finally {
    contents.dispose();
  }
});
