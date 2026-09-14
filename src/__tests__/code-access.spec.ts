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

it('prefers the matching run manifest, supports quoted paths, and checks existence', async () => {
  const project = `version: '0.0.14'\nname: Code preview\ninputs: []\noutputs:\n  - id: plot\n    type: figure\n    format: png\n    recipe:\n      command: python src/current.py\n`;
  const manifest = fileModel(
    JSON.stringify({
      schema_version: 1,
      output_id: 'plot',
      universe_id: 'default',
      recipe: 'python "src/recorded script.py" --out results/default/plot.png'
    })
  );
  const entries = {
    'work/astra.yaml': fileModel(project),
    'work/results/default/plot.png': fileModel('image'),
    'work/results/default/.plot.manifest.json': manifest,
    'work/src/current.py': fileModel('# current'),
    'work/src/recorded script.py': fileModel('# recorded')
  };
  const { contents } = createContents(entries);
  try {
    const { bundle } = await resolveProject(contents, 'work/astra.yaml');
    const data = assembleLoadedProject(bundle, {});
    const output = data.document.analysis.outputs[0];
    expect(
      await resolveOutputCode(contents, 'work/astra.yaml', data, output)
    ).toMatchObject({
      path: 'work/src/recorded script.py',
      source: 'recorded run'
    });
    manifest.content = JSON.stringify({
      schema_version: 1,
      output_id: 'wrong',
      universe_id: 'default',
      recipe: 'python src/wrong.py'
    });
    expect(
      await resolveOutputCode(contents, 'work/astra.yaml', data, output)
    ).toMatchObject({ path: 'work/src/current.py', source: 'declared recipe' });
    manifest.content = JSON.stringify({
      schema_version: 1,
      output_id: 'plot',
      universe_id: 'default',
      recipe: 'python src/missing.py'
    });
    expect(
      await resolveOutputCode(contents, 'work/astra.yaml', data, output)
    ).toBeUndefined();
  } finally {
    contents.dispose();
  }
});
