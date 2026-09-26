import { expect, test } from '@jupyterlab/galata';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { Page } from '@playwright/test';

const project = `version: "0.0.14"
name: Features project
description: Mentions, search, settings, tab labels and the focus layout.
inputs:
  - id: catalog
    label: Supernova catalog
    type: data
    source: data/catalog.csv
outputs:
  - id: hubble_diagram
    label: Hubble diagram
    type: figure
    format: png
    inputs: [catalog]
`;

const other = project
  .replace('Features project', 'Other project')
  .replace('Hubble diagram', 'Other diagram');

const HOME = '.jp-jupyterlab-lightcone-HomeView';

const SIDEBAR = '#jp-lightcone-sidebar';

function execute(
  page: Page,
  command: string,
  args: ReadonlyPartialJSONObject = {}
): Promise<unknown> {
  return page.evaluate(
    async ([command, args]) =>
      window.jupyterapp.commands.execute(command, args).then(() => undefined),
    [command, args] as const
  );
}

/** Open Home for the project folder and the Lightcone sidebar beside it. */
async function openWorkbench(page: Page, tmpPath: string): Promise<void> {
  await execute(page, 'filebrowser:refresh');
  await page.evaluate(() => {
    for (const widget of Array.from(window.jupyterapp.shell.widgets('main'))) {
      widget.close();
    }
  });
  await expect(page.locator(HOME)).toHaveCount(1);
  await expect(page.locator(HOME)).toContainText('Hubble diagram');
  await execute(page, 'jupyterlab_lightcone:show-sidebar');
  await expect(page.locator(SIDEBAR)).toContainText('Hubble diagram');
}

test.beforeEach(async ({ page, tmpPath }) => {
  await page.contents.uploadContent(project, 'text', `${tmpPath}/astra.yaml`);
});

test('tabs of two projects that read the same name their project', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    other,
    'text',
    `${tmpPath}/other/astra.yaml`
  );
  await openWorkbench(page, tmpPath);
  await execute(page, 'jupyterlab_lightcone:open-inventory', {
    path: `${tmpPath}/astra.yaml`
  });
  await execute(page, 'jupyterlab_lightcone:open-inventory', {
    path: `${tmpPath}/other/astra.yaml`
  });
  const tagged = page.locator('.lm-TabBar-tab[data-lightcone-project]');
  await expect(tagged).toHaveCount(2);
  const tags = await tagged.evaluateAll(tabs =>
    tabs.map(tab => tab.getAttribute('data-lightcone-project')).sort()
  );
  expect(tags).toEqual(
    [tmpPath.split('/').pop() ?? '', 'other'].sort((a, b) => a.localeCompare(b))
  );
  // Home names nothing: it is the only tab reading "Home".
  await expect(
    page.locator('.lm-TabBar-tab', { hasText: 'Home' })
  ).not.toHaveAttribute('data-lightcone-project', /.*/);
});

test('the sidebar switches to a recently visited project', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    other,
    'text',
    `${tmpPath}/other/astra.yaml`
  );
  await openWorkbench(page, tmpPath);
  await execute(page, 'filebrowser:go-to-path', {
    path: `${tmpPath}/other`,
    dontShowBrowser: true
  });
  await expect(page.locator(SIDEBAR)).toContainText('Other project');
  await execute(page, 'filebrowser:go-to-path', {
    path: tmpPath,
    dontShowBrowser: true
  });
  await expect(page.locator(SIDEBAR)).toContainText('Features project');
  await page
    .locator(
      `${SIDEBAR} button[aria-label="Switch to another Lightcone project"]`
    )
    .click();
  const menu = page.locator('.jp-jupyterlab-lightcone-ProjectSwitcher');
  await expect(
    menu.getByRole('menuitem', { name: 'other', exact: true })
  ).toBeVisible();
  await menu.locator('.lm-Menu-item', { hasText: 'other' }).click();
  await expect(page.locator(SIDEBAR)).toContainText('Other project');
});
