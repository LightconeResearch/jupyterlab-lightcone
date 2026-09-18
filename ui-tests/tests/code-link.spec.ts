import { expect, test } from '@jupyterlab/galata';

test('opens the current script from the recorded recipe in a reusable editor tab', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  const source = `${tmpPath}/src/plot code.py`;
  await page.contents.uploadContent(
    `version: '0.0.14'
name: Code link preview
inputs: []
outputs:
  - id: plot
    type: figure
    format: svg
    recipe:
      command: python src/current.py
`,
    'text',
    entrypoint
  );
  await page.contents.createDirectory(`${tmpPath}/src`);
  await page.contents.createDirectory(`${tmpPath}/results/default`);
  await page.contents.uploadContent(
    '# Code from the recorded run\nprint(42)\n',
    'text',
    source
  );
  await page.contents.uploadContent(
    '# Different current recipe\n',
    'text',
    `${tmpPath}/src/current.py`
  );
  await page.contents.uploadContent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>',
    'text',
    `${tmpPath}/results/default/plot.svg`
  );
  await page.contents.uploadContent(
    JSON.stringify({
      schema_version: 1,
      output_id: 'plot',
      universe_id: 'default',
      finished_at: '2026-09-15T10:00:00Z',
      git_sha: 'abcdef0123456789',
      recipe: 'python "src/plot code.py"',
      env_version: 'sha256:env',
      lc_version: '0.5',
      input_versions: {}
    }),
    'text',
    `${tmpPath}/results/default/.plot.manifest.json`
  );
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async path => {
      await window.jupyterapp.commands.execute(
        'jupyterlab_lightcone:open-inventory',
        { path, openReference: { kind: 'output', id: 'plot' } }
      );
    }, entrypoint);
    const link = page.getByRole('button', { name: 'Open code', exact: true });
    await expect(link).toHaveAttribute(
      'title',
      /current file: src\/plot code\.py .*recorded run/
    );
    await link.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const widget = window.jupyterapp.shell.currentWidget as unknown as {
            context?: { path?: string };
          };
          return widget?.context?.path;
        })
      )
      .toBe(source);
    ids.push(
      await page.evaluate(() => window.jupyterapp.shell.currentWidget!.id)
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(ids[0]).toBe(ids[1]);
});
