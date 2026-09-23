import { expect, test } from '@jupyterlab/galata';

test('shows the recorded run in provenance tabs and refreshes it after a new run', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(
    `version: '0.0.14'
name: Provenance preview
inputs: []
outputs:
  - id: plot
    type: figure
    format: svg
    recipe:
      command: python current.py
  - id: missing
    type: metric
    format: json
`,
    'text',
    entrypoint
  );
  const record = {
    schema_version: 1,
    universe_id: 'default',
    output_id: 'plot',
    finished_at: '2026-09-15T10:00:00Z',
    git_sha: 'abcdef0123456789',
    recipe: 'python original.py',
    env_version: 'sha256:env',
    input_versions: { catalog: 'sha256:input' },
    lc_version: '0.5'
  };
  let reads = 0;
  await page.route('**/jupyterlab_lightcone/api/materialization?*', route =>
    route.fulfill({
      json: {
        outputs: {
          'default/plot': { state: 'stale', detail: 'the recipe changed' },
          'default/missing': { state: 'stale', detail: 'no manifest' }
        }
      }
    })
  );
  await page.route('**/jupyterlab_lightcone/api/provenance?*', route => {
    reads++;
    const output = new URL(route.request().url()).searchParams.get('output');
    return route.fulfill({
      json: { record: output === 'plot' ? record : null }
    });
  });
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-inventory',
      { path }
    );
  }, entrypoint);
  await expect(
    page.getByRole('button', { name: 'Open figure: plot', exact: true })
  ).toBeVisible();
  expect(reads).toBe(0);
  await page
    .getByRole('button', { name: 'Open figure: plot', exact: true })
    .click();
  const dialog = page.locator('dialog[open].astra-dialog[data-kind="output"]');
  await expect(
    dialog.getByText('python current.py', { exact: true })
  ).toBeVisible();
  // The provenance tabs follow the recipe, and open on the run itself.
  const provenance = dialog.locator('.jp-jupyterlab-lightcone-Provenance');
  expect(
    await provenance.evaluate(node => node.previousElementSibling?.textContent)
  ).toContain('python current.py');
  await expect(
    provenance.getByRole('tab', { name: 'Run', exact: true })
  ).toHaveAttribute('aria-selected', 'true');
  const panel = provenance.getByRole('tabpanel');
  await expect(panel).toContainText('stale');
  await expect(panel).toContainText('the recipe changed');
  await expect(
    panel.getByText('python original.py', { exact: true })
  ).toBeVisible();
  await expect(
    panel.getByText('abcdef0123456789', { exact: true })
  ).toBeVisible();
  await provenance.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await expect(panel.getByText('catalog', { exact: true })).toBeVisible();
  await expect(panel.getByText('sha256:input', { exact: true })).toBeVisible();
  await provenance
    .getByRole('tab', { name: 'Environment', exact: true })
    .click();
  await expect(panel.getByText('sha256:env', { exact: true })).toBeVisible();
  await expect(panel.getByText('0.5', { exact: true })).toBeVisible();
  await provenance.getByRole('tab', { name: 'Run', exact: true }).click();
  // A newly recorded run must refresh even when the CLI state stays stale.
  record.git_sha = 'fedcba9876543210';
  await page.evaluate(async path => {
    const contents = window.jupyterapp.serviceManager.contents;
    const file = await contents.get(path);
    await contents.save(path, {
      type: 'file',
      format: 'text',
      content: `${file.content}\ndescription: Updated project metadata\n`
    });
  }, entrypoint);
  await expect(
    panel.getByText('fedcba9876543210', { exact: true })
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Close output details', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Open metric: missing', exact: true })
    .click();
  await expect(
    dialog.getByText('No run has been recorded for this output.', {
      exact: true
    })
  ).toBeVisible();
});
