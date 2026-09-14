import { expect, test } from '@jupyterlab/galata';

const spec = (description = 'Original input') => `version: '0.0.14'
name: Update preview
inputs:
  - id: catalog
    type: data
    description: ${description}
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
`;

test('minimal project notifications group edits, review records, and distinguish result content from timestamps', async ({
  page,
  tmpPath
}) => {
  const path = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(spec(), 'text', path);
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-inventory',
      { path }
    );
  }, path);
  const review = page.getByRole('button', {
    name: 'Review changes',
    exact: true
  });
  await expect(review).toHaveCount(0);
  const beforeWidget = await page.evaluate(
    () => window.jupyterapp.shell.currentWidget?.id
  );
  await page.contents.uploadContent(
    spec('Revised input').replace('default: narrow', 'default: wide'),
    'text',
    path
  );
  await expect(review).toBeVisible({ timeout: 15000 });
  expect(
    await page.evaluate(() => window.jupyterapp.shell.currentWidget?.id)
  ).toBe(beforeWidget);
  await review.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('input changed', { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByText('decision changed', { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByText('48–152 → 40–160', { exact: true })
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/project-updates-review.png' });
  await dialog
    .getByRole('button', { name: 'Fitting range', exact: true })
    .click();
  await expect(
    page.locator('.jp-jupyterlab-lightcone-project-updates')
  ).toHaveCount(0);
  await expect(
    page.getByRole('dialog').getByText('Fitting range', { exact: true }).first()
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.contents.createDirectory(`${tmpPath}/results/default`);
  await page.contents.uploadContent(
    '{"value":42}',
    'text',
    `${tmpPath}/results/default/fit.json`
  );
  await expect(review).toBeVisible({ timeout: 15000 });
  await review.click();
  await expect(dialog.getByText('result ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // Equal-length content change must notify; an identical rewrite must stay quiet.
  await page.contents.uploadContent(
    '{"value":43}',
    'text',
    `${tmpPath}/results/default/fit.json`
  );
  await expect(review).toBeVisible({ timeout: 15000 });
  await review.click();
  await expect(
    dialog.getByText('result updated', { exact: true })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.contents.uploadContent(
    '{"value":43}',
    'text',
    `${tmpPath}/results/default/fit.json`
  );
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:refresh');
  });
  // Allow the batching window to expire; no toast or stored review action appears.
  await page.waitForTimeout(4500);
  await expect(review).toHaveCount(0);
});

test('review preserves the universe of a changed pinned record', async ({
  page,
  tmpPath
}) => {
  const path = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(spec(), 'text', path);
  await page.contents.createDirectory(`${tmpPath}/universes`);
  await page.contents.uploadContent(
    'id: baseline\ndecisions:\n  range: narrow\n',
    'text',
    `${tmpPath}/universes/baseline.yaml`
  );
  await page.contents.uploadContent(
    'id: alternate\ndecisions:\n  range: narrow\n',
    'text',
    `${tmpPath}/universes/alternate.yaml`
  );
  // The inventory selects alternate alphabetically; the standalone record pins baseline.
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-inventory',
      { path }
    );
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-element',
      { entrypoint: path, target: 'decisions.range', universeId: 'baseline' }
    );
  }, path);
  await expect(
    page
      .locator('.jp-jupyterlab-lightcone-element')
      .getByRole('heading', { name: 'Fitting range', exact: true })
  ).toBeVisible();
  await page.contents.uploadContent(
    'id: baseline\ndecisions:\n  range: wide\n',
    'text',
    `${tmpPath}/universes/baseline.yaml`
  );
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click({ timeout: 15000 });
  await expect(
    page.getByRole('dialog').getByText('48–152 → 40–160')
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Fitting range', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const widget = window.jupyterapp.shell.currentWidget as unknown as {
          content?: { reference?: { universeId?: string; target?: string } };
        };
        return widget?.content?.reference;
      })
    )
    .toMatchObject({ universeId: 'baseline', target: 'decisions.range' });
});
