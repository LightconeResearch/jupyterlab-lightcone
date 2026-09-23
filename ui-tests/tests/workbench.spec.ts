import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

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
const FIGURE = '.astra-output-detail__artifact img';
const PIN = '.jp-jupyterlab-lightcone-CommentPin';
const CHIP =
  '.jp-jupyterlab-lightcone-CommentTray .jp-jupyterlab-lightcone-CommentChip';
const CARD = '.jp-jupyterlab-lightcone-CommentCard';
const COMMENTS_API = '/jupyterlab_lightcone/api/comments';

/** A 320×200 single-color PNG: a figure large enough to point at. */
const FIGURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAABvUlEQVR42u3TQQkAAAgEwUtnHDMZ1RC+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMXCwHGRt19S3HZgAAAABJRU5ErkJggg==';

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

test('a comment pinned on a figure waits above the composer and travels with the next message', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    fs.readFileSync(
      path.resolve(__dirname, '../fixtures/personas/lightcone_persona.py'),
      'utf8'
    ),
    'text',
    `${tmpPath}/.jupyter/personas/lightcone_persona.py`
  );
  await page.contents.uploadContent(
    FIGURE_PNG,
    'base64',
    `${tmpPath}/results/default/hubble_diagram.png`
  );
  await openWorkbench(page, tmpPath);
  await page
    .locator('.jp-jupyterlab-lightcone-Home-plate', {
      hasText: 'Hubble diagram'
    })
    .click();
  const record = page.locator(RECORD).first();
  const figure = record.locator(FIGURE);
  await expect(figure).toHaveClass(/jp-jupyterlab-lightcone-Commentable/);

  // A click on the figure drops a point and asks for the comment.
  const box = await figure.boundingBox();
  if (!box) {
    throw new Error('The figure has no layout box.');
  }
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
  const popover = page.getByRole('dialog', { name: 'Comment' });
  await expect(popover).toBeVisible();
  const created = page.waitForResponse(
    response =>
      response.url().includes(COMMENTS_API) &&
      response.request().method() === 'POST'
  );
  await popover
    .getByRole('textbox', { name: 'Comment' })
    .fill('Move the legend');
  await page.keyboard.press('Enter');
  expect((await created).status()).toBe(201);
  await expect(popover).toBeHidden();
  const pin = record.locator(PIN);
  await expect(pin).toHaveText('①');
  await expect(page.locator(SIDEBAR)).toContainText('1 pending comment');

  // Every session of the project shows it above the composer...
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  const chip = page.locator(CHIP);
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('①');
  await expect(chip).toContainText('Move the legend');

  // ...and its chip leads back to the pin on the figure.
  await chip.locator('.jp-jupyterlab-lightcone-CommentChip-open').click();
  await expect.poll(() => currentTitle(page)).toBe('Hubble diagram');
  await expect(pin).toBeInViewport();

  // Sending the next message takes the comment to the agent, not into the chat.
  await page.locator('.lm-TabBar-tab', { hasText: 'untitled.chat' }).click();
  const composer = page.locator(CHAT_INPUT).getByRole('combobox');
  await composer.fill('Compare the options.');
  await page.locator('.jp-chat-send-button').click();
  const received = page
    .locator('.jp-chat-rendered-message')
    .filter({ hasText: 'Agent received:' });
  await expect(received).toContainText('Comments on this project (1)', {
    timeout: 30000
  });
  await expect(received).toContainText('outputs.hubble_diagram');
  await expect(received).toContainText('"Move the legend"');
  // The cards sit in the message's preamble, above its rendered body.
  const sent = page
    .locator('.jp-chat-message')
    .filter({ has: page.locator(CARD) });
  await expect(sent).toContainText('Compare the options.');
  await expect(sent).not.toContainText('Comments on this project');
  await expect(sent.locator(CARD)).toContainText('Move the legend');

  // It is no longer pending anywhere: not above the composer, not in the
  // sidebar, and not on the figure once it is shown again.
  await expect(chip).toHaveCount(0);
  await expect(page.locator(SIDEBAR)).not.toContainText('pending comment');
  await page.locator('.lm-TabBar-tab', { hasText: 'Hubble diagram' }).click();
  await expect(figure).toBeVisible();
  await expect(pin).toHaveCount(0);
  const response = await page.request.get(
    `${COMMENTS_API}?${new URLSearchParams({
      path: `${tmpPath}/astra.yaml`,
      status: 'sent'
    })}`
  );
  const { comments } = (await response.json()) as {
    comments: { text: string; sentWith: { chat: string } | null }[];
  };
  expect(comments.map(comment => comment.text)).toEqual(['Move the legend']);
  expect(comments[0].sentWith?.chat).toBe(`${tmpPath}/chats/untitled.chat`);
});
