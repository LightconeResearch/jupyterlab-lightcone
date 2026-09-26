import { expect, test } from '@jupyterlab/galata';

test('a renamed output opens its recorded bytes and never substitutes an unlisted commit', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(
    `version: '0.0.14'
name: Versioned tables
inputs: []
outputs:
  - id: table
    type: table
    format: tsv
`,
    'text',
    entrypoint
  );
  const newer = 'b'.repeat(40);
  const older = 'a'.repeat(40);
  await page.route('**/jupyterlab_lightcone/api/versions?*', route =>
    route.fulfill({
      json: {
        file: 'results/default/table.tsv',
        annex: 'none',
        versions: [
          { commit: newer, file: 'results/default/table.tsv' },
          { commit: older, file: 'results/default/table.csv' }
        ].map(version => ({
          ...version,
          short: version.commit.slice(0, 7),
          time: '2026-09-20T10:00:00Z',
          subject: 'Materialize table',
          size: 24,
          present: true,
          annex: null,
          manifest: null
        }))
      }
    })
  );
  await page.route('**/jupyterlab_lightcone/api/versions/content?*', route =>
    route.fulfill({
      contentType: 'text/csv',
      body: 'first,second\nold-a,old-b\n'
    })
  );
  const open = (versionCommit: string) =>
    page.evaluate(
      args =>
        window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:open-element',
          args
        ),
      { entrypoint, target: 'outputs.table', versionCommit }
    );
  await open(older);
  const record = page.locator('.jp-jupyterlab-lightcone-element:visible');
  await expect(record.getByText('old-a', { exact: true })).toBeVisible();
  await expect(record.getByText('old-b', { exact: true })).toBeVisible();
  await expect(record).toContainText('Older version');
  await open('f'.repeat(40));
  await expect(record).toContainText('outside the available history');
  await expect(record.getByText('old-a', { exact: true })).toHaveCount(0);
  await expect(
    record.getByRole('button', { name: 'Latest', exact: true })
  ).toBeVisible();
});
