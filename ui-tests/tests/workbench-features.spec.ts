import { expect, test } from '@jupyterlab/galata';
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
const CHAT_INPUT = '.jp-chat-input-container';
const SEARCH = '.jp-jupyterlab-lightcone-Search';

function execute(
  page: Page,
  command: string,
  args: Record<string, unknown> = {}
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

test('the composer completes @ records and # sessions into visible references', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    JSON.stringify({
      messages: [],
      users: {},
      attachments: {},
      metadata: {}
    }),
    'text',
    `${tmpPath}/chats/contour-styling.chat`
  );
  await openWorkbench(page, tmpPath);
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  const composer = page.locator(CHAT_INPUT).getByRole('combobox');
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type('Look at @hub');
  const option = page.locator('.jp-chat-command-name', {
    hasText: '@outputs.hubble_diagram'
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(composer).toContainText('`outputs.hubble_diagram`');
  await page.keyboard.type(' and #cont');
  const session = page.locator('.jp-chat-command-name', {
    hasText: '#contour-styling'
  });
  await expect(session).toBeVisible();
  await session.click();
  await expect(composer).toContainText('`chats/contour-styling.chat`');
});

test('search finds the text of a session and opens it', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    JSON.stringify({
      messages: [
        {
          id: 'm1',
          body: 'Plot the Hubble residuals',
          sender: 'researcher',
          time: 1,
          type: 'msg'
        },
        {
          id: 'm2',
          body: 'The residuals flatten above redshift one.',
          sender: 'jupyter-ai-personas::test::Agent',
          time: 2,
          type: 'msg'
        }
      ],
      users: {},
      attachments: {},
      metadata: {}
    }),
    'text',
    `${tmpPath}/chats/residuals.chat`
  );
  await openWorkbench(page, tmpPath);
  await execute(page, 'jupyterlab_lightcone:search');
  await expect(page.locator(SEARCH)).toBeVisible();
  await page.keyboard.type('flatten above');
  const hit = page.locator(`${SEARCH} .lm-CommandPalette-item`, {
    hasText: 'residuals flatten above'
  });
  await expect(hit).toBeVisible();
  // The hit is filed under the session text, after the titles.
  await expect(
    page.locator(`${SEARCH} .lm-CommandPalette-header`, {
      hasText: 'In sessions'
    })
  ).toHaveCount(1);
  await hit.click();
  await expect(page.locator(SEARCH)).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.jupyterapp.shell.currentWidget?.title.label)
    )
    .toBe('residuals.chat');
});

test('the settings page reports the project kernel, container and compute', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await execute(page, 'jupyterlab_lightcone:open-customize');
  const settings = page.locator('.jp-jupyterlab-lightcone-Customize');
  await expect(settings).toContainText('Notebook kernel');
  await expect(settings).toContainText('Container');
  await expect(settings).toContainText('Compute');
  await expect(settings).toContainText('ACP client installed');
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
  await expect(menu).toContainText('Recent projects');
  await menu.locator('.lm-Menu-item', { hasText: 'other' }).click();
  await expect(page.locator(SIDEBAR)).toContainText('Other project');
});

test('Focus Layout hides the status bar and the right area, and brings them back', async ({
  page
}) => {
  const statusBar = page.locator('#jp-main-statusbar');
  await expect(statusBar).toBeVisible();
  await execute(page, 'jupyterlab_lightcone:focus-layout');
  await expect(statusBar).toBeHidden();
  expect(
    await page.evaluate(() =>
      window.jupyterapp.commands.isToggled('jupyterlab_lightcone:focus-layout')
    )
  ).toBe(true);
  await execute(page, 'jupyterlab_lightcone:focus-layout');
  await expect(statusBar).toBeVisible();
});
