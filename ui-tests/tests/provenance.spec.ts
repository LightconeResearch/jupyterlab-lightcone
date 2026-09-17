import { expect, test } from '@jupyterlab/galata';

test('shows a compact provenance summary and opens run details in a popup', async ({
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
  const dialog = page.locator('.astra-dialog[data-kind="output"]');
  await expect(
    dialog.getByText('python current.py', { exact: true })
  ).toBeVisible();
  expect(
    await dialog
      .locator('[data-slot="output-provenance"]')
      .evaluate(node => node.previousElementSibling?.textContent)
  ).toContain('python current.py');
  await expect(dialog.getByText('Stale', { exact: true })).toBeVisible();
  await expect(dialog.getByText('abcdef01', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('python original.py', { exact: true })
  ).toBeHidden();
  const detailsLink = dialog.getByRole('button', {
    name: 'Details',
    exact: true
  });
  await detailsLink.click();
  const popup = page.getByRole('dialog', { name: 'Run details', exact: true });
  await expect(
    popup.getByText('python original.py', { exact: true })
  ).toBeVisible();
  await expect(popup.getByText('sha256:input', { exact: true })).toBeVisible();
  await expect(popup.getByText('sha256:env', { exact: true })).toBeVisible();
  await popup.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(detailsLink).toBeFocused();
  await detailsLink.click();
  await popup
    .getByRole('button', { name: 'Close run details', exact: true })
    .click();
  await expect(dialog).toBeVisible();
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
  await expect(dialog.getByText('fedcba98', { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Close output details', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Open metric: missing', exact: true })
    .click();
  await expect(
    dialog.getByText('No recorded run yet.', { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Details', exact: true })
  ).toHaveCount(0);
});
