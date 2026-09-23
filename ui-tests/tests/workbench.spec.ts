import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

const project = `version: "0.0.14"
name: Workbench project
description: Navigation between Home, the sidebar, sessions and record tabs.
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
    decisions: [cosmological_model]
  - id: cosmology_fit
    label: Cosmology fit
    type: table
    format: json
    inputs: [catalog]
    decisions: [sample_cut]
decisions:
  cosmological_model:
    label: Cosmological model
    rationale: Curvature is poorly constrained by supernovae alone.
    default: flat
    options:
      flat:
        label: Flat LambdaCDM
        insights: [precedent]
      curved:
        label: Curved LambdaCDM
  sample_cut:
    label: Sample cut
    default: none
    options:
      none:
        label: Keep every supernova
prior_insights:
  precedent:
    label: Flat prior precedent
    claim: Earlier supernova analyses fixed the curvature to zero.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: 10.1234/example
`;

const HOME = '.jp-jupyterlab-lightcone-HomeView';
const SIDEBAR = '#jp-lightcone-sidebar';
const RECORD = '.jp-jupyterlab-lightcone-ElementWidget';
const RECORD_TABS = '.lm-TabBar-tab[data-lightcone-element]';
const TOOLBAR = '.jp-jupyterlab-lightcone-element-toolbar';
const CONTENT = '.jp-jupyterlab-lightcone-element-content';
const CHAT_INPUT = '.jp-chat-input-container';
const SEARCH = '.jp-jupyterlab-lightcone-Search';

/** The labels of every main-area tab bar, left to right. */
function tabBars(page: Page): Promise<string[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#jp-main-dock-panel .lm-TabBar')).map(
      bar =>
        Array.from(
          bar.querySelectorAll('.lm-TabBar-tab .lm-TabBar-tabLabel')
        ).map(label => label.textContent ?? '')
    )
  );
}

function currentTitle(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => window.jupyterapp.shell.currentWidget?.title.label
  );
}

function execute(
  page: Page,
  command: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  return page.evaluate(
    async ([command, args]) => {
      await window.jupyterapp.commands.execute(command, args);
    },
    [command, args] as const
  );
}

/** Open Home for the project folder and the Lightcone sidebar beside it. */
async function openWorkbench(page: Page, tmpPath: string): Promise<void> {
  // The launcher Galata opened predates the project file; a file browser
  // refresh lets the current project notice it, and emptying the main area
  // reopens the launcher in the project folder, where it becomes Home.
  await execute(page, 'filebrowser:refresh');
  await page.evaluate(() => {
    for (const widget of Array.from(window.jupyterapp.shell.widgets('main'))) {
      widget.close();
    }
  });
  await expect(page.locator(HOME)).toHaveCount(1);
  await expect(page.locator(HOME)).toContainText('Hubble diagram');
  await expect(page.locator(HOME)).toContainText(tmpPath);
  await execute(page, 'jupyterlab_lightcone:show-sidebar');
  await expect(page.locator(SIDEBAR)).toContainText('Hubble diagram');
}

test.beforeEach(async ({ page, tmpPath }) => {
  await page.contents.uploadContent(project, 'text', `${tmpPath}/astra.yaml`);
});

test('Home keeps its place while a result opens beside it and navigates its own history', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page
    .locator('.jp-jupyterlab-lightcone-Home-plate', {
      hasText: 'Hubble diagram'
    })
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  // The first result splits to the right of Home; Home stays where it was.
  expect(await tabBars(page)).toEqual([['Home'], ['Hubble diagram']]);
  expect(await currentTitle(page)).toBe('Hubble diagram');

  const record = page.locator(RECORD).first();
  const back = record.getByRole('button', { name: 'Back' });
  await expect(back).toBeDisabled();
  const currentResult = page.locator(`${SIDEBAR} [aria-current="true"]`, {
    hasText: 'Hubble diagram'
  });
  await expect(currentResult).toHaveCount(1);
  // Read to the bottom of the result before following a link out of it.
  await page.setViewportSize({ width: 1440, height: 640 });
  const content = record.locator(CONTENT);
  const scrolled = await content.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await record
    .getByRole('button', { name: 'View decision: Cosmological model' })
    .click();
  await expect(record.locator(TOOLBAR)).toContainText(
    'outputs.hubble_diagram›decisions.cosmological_model'
  );
  expect(await tabBars(page)).toEqual([['Home'], ['Cosmological model']]);
  // The sidebar follows the tab: a decision is no result.
  await expect(currentResult).toHaveCount(0);

  await record
    .getByRole('button', { name: /insight/i })
    .first()
    .click();
  await expect(record.locator(TOOLBAR)).toContainText(
    'prior_insights.precedent'
  );
  expect(await currentTitle(page)).toBe('Flat prior precedent');

  // Back, Back returns to the result; Forward reaches the decision again.
  await record.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(record.locator(TOOLBAR)).not.toContainText('prior_insights');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(record.locator(TOOLBAR)).not.toContainText('decisions.');
  expect(await currentTitle(page)).toBe('Hubble diagram');
  await expect(back).toBeDisabled();
  // Coming back resumes where the result was left, and the sidebar agrees.
  await expect
    .poll(() => content.evaluate(element => element.scrollTop))
    .toBe(scrolled);
  await expect(currentResult).toHaveCount(1);
  await page.keyboard.press('Alt+ArrowRight');
  expect(await currentTitle(page)).toBe('Cosmological model');
  // Home was never touched, and the sidebar follows the current record.
  await expect(page.locator(HOME)).toContainText('Workbench project');
});

test('a session takes its results beside it and gets focus back when they close', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  // The session joins Home's group at full width.
  expect(await tabBars(page)).toEqual([['Home', 'untitled.chat']]);
  await expect(page.locator(SIDEBAR)).toContainText('untitled');

  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Hubble diagram' })
    .first()
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  expect(await tabBars(page)).toEqual([
    ['Home', 'untitled.chat'],
    ['Hubble diagram']
  ]);

  await page.locator(`${RECORD_TABS} .lm-TabBar-tabCloseIcon`).click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(0);
  expect(await currentTitle(page)).toBe('untitled.chat');
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('.jp-chat-input-container')
    )
  ).toBe(true);
});

test('a pinned result survives opening the next one from the sidebar', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Hubble diagram' })
    .first()
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  await page
    .locator(`${RECORD} button`, { hasText: 'Pin tab' })
    .first()
    .click();
  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Cosmology fit' })
    .first()
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(2);
  expect(await tabBars(page)).toEqual([
    ['Home'],
    ['Hubble diagram', 'Cosmology fit']
  ]);
  // The pinned tab keeps an upright label; the preview stays italic.
  await expect(
    page.locator(`${RECORD_TABS} .lm-TabBar-tabLabel`).first()
  ).toHaveCSS('font-style', 'normal');
  await expect(
    page.locator(`${RECORD_TABS} .lm-TabBar-tabLabel`).last()
  ).toHaveCSS('font-style', 'italic');
});

test('search opens sessions in the main area and records as record tabs', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  await page.locator('.lm-TabBar-tab', { hasText: 'Home' }).click();
  expect(await currentTitle(page)).toBe('Home');

  await execute(page, 'jupyterlab_lightcone:search');
  await expect(page.locator(SEARCH)).toBeVisible();
  await page.keyboard.type('untitled');
  await expect(
    page.locator(`${SEARCH} .lm-CommandPalette-item`).first()
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator(SEARCH)).toBeHidden();
  await expect.poll(() => currentTitle(page)).toBe('untitled.chat');

  await execute(page, 'jupyterlab_lightcone:search');
  await expect(page.locator(SEARCH)).toBeVisible();
  await page.keyboard.type('Sample cut');
  await expect(
    page.locator(`${SEARCH} .lm-CommandPalette-item`).first()
  ).toContainText('Sample cut');
  await page.keyboard.press('Enter');
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  await expect.poll(() => currentTitle(page)).toBe('Sample cut');

  // Escape closes the modal and leaves the current tab current.
  await execute(page, 'jupyterlab_lightcone:search');
  await expect(page.locator(SEARCH)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(SEARCH)).toBeHidden();
  expect(await currentTitle(page)).toBe('Sample cut');
});

test('the schemas register the search shortcut and the launcher entries', async ({
  page
}) => {
  const bindings = await page.evaluate(() =>
    window.jupyterapp.commands.keyBindings
      .filter(binding =>
        ['jupyterlab_lightcone:search', 'launcher:create'].includes(
          binding.command
        )
      )
      .map(binding => `${binding.command}: ${binding.keys.join(' ')}`)
      .sort()
  );
  expect(bindings).toEqual([
    'jupyterlab_lightcone:search: Ctrl K',
    'launcher:create: Ctrl Shift L'
  ]);
  await expect(
    page.locator('#filebrowser .jp-Toolbar [title^="New Launcher"]')
  ).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await expect(page.locator(SEARCH)).toBeVisible();
  await page.keyboard.press('Escape');
});
