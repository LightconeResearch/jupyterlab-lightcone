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
const HOME_TAB = '.jp-jupyterlab-lightcone-Home';
const PLATE_NAME = '.jp-jupyterlab-lightcone-Home-plateName';
const PLATE_PREVIEW = '.jp-jupyterlab-lightcone-Home-platePreview';
const TOOLS_MENU = '.jp-jupyterlab-lightcone-HomeTools';
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
  // Back and Forward draw their arrows, whatever the font makes of ◀ ▶.
  const arrow = await back.locator('svg').boundingBox();
  expect(arrow?.width ?? 0).toBeGreaterThanOrEqual(12);
  const currentResult = page.locator(`${SIDEBAR} [aria-current="true"]`, {
    hasText: 'Hubble diagram'
  });
  await expect(currentResult).toHaveCount(1);
  // Read to the bottom of the result before following a link out of it.
  await page.setViewportSize({ width: 1440, height: 640 });
  const content = record.locator(CONTENT);
  // Lumino lays the dock out again on the next frame: scroll the record once
  // it has its new height, or the link below would need scrolling to reach.
  await expect
    .poll(() => content.evaluate(element => element.clientHeight))
    .toBeLessThan(600);
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

test('a session tab reads as its first message, and a reload restores Home beside it', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  const composer = page.locator(CHAT_INPUT).getByRole('combobox');
  await composer.fill('Plot the residuals against redshift\nwith error bars');
  await page.locator('.jp-chat-send-button').click();
  const session = page.locator(
    '.lm-TabBar-tab[data-lightcone-session-title="Plot the residuals against redshift"]'
  );
  await expect(session).toHaveCount(1);
  // The tab shows the title (browsers also name the tab by it); the file
  // keeps its name.
  expect(
    await session.evaluate(tab => getComputedStyle(tab, '::before').content)
  ).toBe('"Plot the residuals against redshift"');
  await expect(session.locator('.lm-TabBar-tabLabel')).toBeHidden();
  // A session started empty is named after its first message, as Home names
  // the sessions it starts; the open tab follows the rename.
  const named = 'plot-the-residuals-against-redshift.chat';
  await expect
    .poll(() => page.contents.fileExists(`${tmpPath}/chats/${named}`))
    .toBe(true);
  expect(await page.contents.fileExists(`${tmpPath}/chats/untitled.chat`)).toBe(
    false
  );
  await expect.poll(() => currentTitle(page)).toBe(named);

  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Hubble diagram' })
    .first()
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  const layout = [['Home', named], ['Hubble diagram']];
  expect(await tabBars(page)).toEqual(layout);

  // Home is the project's front page: a reload puts it back with the rest.
  // Wait for the workspace save rather than relying on a fixed sleep.
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        JSON.stringify(await window.jupyterapp.serviceManager.workspaces.list())
      )
    )
    .toMatch(
      /lightcone-home:.*lightcone-element-|lightcone-element-.*lightcone-home:/
    );
  await page.reload({ waitForIsReady: false });
  await page.waitForSelector('#jupyterlab-splash', { state: 'detached' });
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  await expect(page.locator(HOME)).toHaveCount(1);
  await expect.poll(() => tabBars(page)).toEqual(layout);
  await expect(session).toHaveCount(1);
});

test('a record opened in a new tab stays when the next result replaces the preview', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Hubble diagram' })
    .first()
    .click();
  await expect(page.locator(RECORD_TABS)).toHaveCount(1);
  // Middle-click opens the decision beside the result without navigating it.
  await page
    .locator(RECORD)
    .first()
    .getByRole('button', { name: 'View decision: Cosmological model' })
    .click({ button: 'middle' });
  await expect(page.locator(RECORD_TABS)).toHaveCount(2);
  expect(await tabBars(page)).toEqual([
    ['Home'],
    ['Hubble diagram', 'Cosmological model']
  ]);
  await expect(
    page.locator(`${RECORD_TABS}.jp-jupyterlab-lightcone-pinned-tab`)
  ).toHaveText('Cosmological model');
  // The group keeps one preview: the next result replaces the first one.
  await page
    .locator(`${SIDEBAR} button`, { hasText: 'Cosmology fit' })
    .first()
    .click();
  await expect
    .poll(() => tabBars(page))
    .toEqual([['Home'], ['Cosmology fit', 'Cosmological model']]);
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

test('Home plates follow the Lab theme, lead with figures and list a fit’s values', async ({
  page,
  tmpPath
}) => {
  // The table is declared before the figure; Home still leads with the figure.
  const [head, rest] = project.split('outputs:\n');
  const [outputs, tail] = rest.split('decisions:\n');
  const [hubble, fit] = outputs.split(/(?= {2}- id: cosmology_fit)/);
  await page.contents.uploadContent(
    `${head}outputs:\n${fit}${hubble}decisions:\n${tail}`,
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.contents.uploadContent(
    FIGURE_PNG,
    'base64',
    `${tmpPath}/results/default/hubble_diagram.png`
  );
  await page.contents.uploadContent(
    JSON.stringify([
      { model: 'flat_lcdm', omega_m: 0.29131347504573885, chi2_min: 545.1 }
    ]),
    'text',
    `${tmpPath}/results/default/cosmology_fit.json`
  );
  await openWorkbench(page, tmpPath);
  await expect(page.locator(`${HOME} ${PLATE_NAME}`)).toHaveText([
    'Hubble diagram',
    'Cosmology fit'
  ]);
  const plates = page.locator(`${HOME} ${PLATE_PREVIEW}`);
  await expect(plates.first().locator('img')).toBeVisible();
  // A one-row table reads as field and value lines, not as cut columns.
  await expect(plates.last().locator('pre')).toContainText('omega_m    0.2913');
  // Under JupyterLab Light the previews use Lab's fonts and draw no frame
  // of their own inside the plate.
  const fonts = await plates.evaluateAll(elements =>
    elements.flatMap(element =>
      Array.from(
        element.querySelectorAll('*'),
        child => getComputedStyle(child).fontFamily
      )
    )
  );
  expect(fonts.filter(font => font.includes('Lightcone Brand'))).toEqual([]);
  await expect(plates.first().locator('.astra-artifact')).toHaveCSS(
    'border-top-width',
    '0px'
  );
});

test('Tools opens the launcher items in the project and switches to the full launcher', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  const tools = page.locator(`${HOME} .jp-jupyterlab-lightcone-Home-tools`);
  await tools.click();
  const menu = page.locator(TOOLS_MENU);
  await expect(menu).toBeVisible();
  // The menu hangs from the button's right edge, at the header's end.
  const [menuBox, toolsBox] = await Promise.all([
    menu.boundingBox(),
    tools.boundingBox()
  ]);
  if (!menuBox || !toolsBox) {
    throw new Error('The Tools button or menu has no layout box.');
  }
  expect(
    Math.abs(menuBox.x + menuBox.width - (toolsBox.x + toolsBox.width))
  ).toBeLessThanOrEqual(2);
  // An item runs in the project folder and opens beside Home.
  await menu.locator('.lm-Menu-item', { hasText: 'Text File' }).click();
  await expect
    .poll(() => page.contents.fileExists(`${tmpPath}/untitled.txt`))
    .toBe(true);
  await expect.poll(() => tabBars(page)).toEqual([['Home', 'untitled.txt']]);

  await page.locator('.lm-TabBar-tab', { hasText: 'Home' }).click();
  await tools.click();
  await menu
    .locator('.lm-Menu-item', { hasText: 'Show the full launcher' })
    .click();
  await expect(page.locator(`${HOME_TAB} .jp-Launcher`)).toBeVisible();
  await expect(page.locator(HOME)).toBeHidden();
  expect(await currentTitle(page)).toBe('Launcher');
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(page.locator(HOME)).toBeVisible();
  expect(await currentTitle(page)).toBe('Home');
});

test('the sidebar’s Home button brings the open Home forward', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await page.locator(`${SIDEBAR} button`, { hasText: 'New session' }).click();
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  expect(await currentTitle(page)).toBe('untitled.chat');
  await page
    .locator(`${SIDEBAR} button[aria-label="Open Home for this project"]`)
    .click();
  await expect.poll(() => currentTitle(page)).toBe('Home');
  expect(await tabBars(page)).toEqual([['Home', 'untitled.chat']]);
});

test('narrow tabs wrap and stack by their own width', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  // A window this wide leaves the settings page under 560 px, while the
  // window itself stays well above it.
  await page.setViewportSize({ width: 820, height: 900 });
  await execute(page, 'jupyterlab_lightcone:open-customize');
  const settings = page.locator('.jp-jupyterlab-lightcone-Customize');
  const row = settings
    .locator('.jp-jupyterlab-lightcone-Customize-row')
    .first();
  await expect(row).toBeVisible();
  const columns = await row.evaluate(
    element => getComputedStyle(element).gridTemplateColumns
  );
  expect(columns.trim().split(/\s+/)).toHaveLength(1);
  expect(
    await settings.evaluate(
      element => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);

  // A record beside Home gets a third of the window: its context line keeps
  // a readable width instead of breaking every word.
  await page.locator('.lm-TabBar-tab', { hasText: 'Home' }).click();
  await page
    .locator('.jp-jupyterlab-lightcone-Home-plate', {
      hasText: 'Hubble diagram'
    })
    .click();
  const context = page
    .locator(RECORD)
    .first()
    .locator('.jp-jupyterlab-lightcone-element-context');
  await expect(context).toBeVisible();
  const box = await context.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(150);
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
  // The pin is drawn where the figure was clicked, not at its corner: the
  // record tab's reset of native controls must leave the pin's own look.
  const [pinBox, figureBox] = await Promise.all([
    pin.boundingBox(),
    figure.boundingBox()
  ]);
  if (!pinBox || !figureBox) {
    throw new Error('The pin or the figure has no layout box.');
  }
  expect(
    Math.abs(
      pinBox.x + pinBox.width / 2 - (figureBox.x + figureBox.width * 0.4)
    )
  ).toBeLessThan(2);
  expect(
    Math.abs(
      pinBox.y + pinBox.height / 2 - (figureBox.y + figureBox.height * 0.3)
    )
  ).toBeLessThan(2);
  // The keyboard opens a pin too, with Edit and Delete.
  await pin.focus();
  await page.keyboard.press('Enter');
  await expect(popover).toContainText('Move the legend');
  await expect(popover.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Delete' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

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
  // The session is renamed after its first message, which may happen before
  // or after the server records where the comment went.
  expect([
    `${tmpPath}/chats/untitled.chat`,
    `${tmpPath}/chats/compare-the-options.chat`
  ]).toContain(comments[0].sentWith?.chat);
});

test('a comment on the text of a record is marked beside the quote, not over it', async ({
  page,
  tmpPath
}) => {
  await openWorkbench(page, tmpPath);
  await execute(page, 'jupyterlab_lightcone:open-element', {
    entrypoint: `${tmpPath}/astra.yaml`,
    target: 'decisions.cosmological_model'
  });
  const record = page.locator(RECORD).first();
  const quote = 'poorly constrained';
  await expect(record).toContainText(quote);

  // Drag across the quote, which starts in the middle of its line.
  const ends = await record.evaluate((root, quote) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const start = text.data.indexOf(quote);
      if (start < 0) {
        continue;
      }
      const box = (from: number, to: number) => {
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        return range.getBoundingClientRect();
      };
      const first = box(start, start + 1);
      const last = box(start + quote.length - 1, start + quote.length);
      const column = text.parentElement?.getBoundingClientRect();
      return {
        x1: first.left + 1,
        y1: first.top + first.height / 2,
        x2: last.right - 1,
        y2: last.top + last.height / 2,
        column: column?.left ?? 0
      };
    }
    return null;
  }, quote);
  if (!ends) {
    throw new Error('The quote was not found in the record.');
  }
  await page.mouse.move(ends.x1, ends.y1);
  await page.mouse.down();
  await page.mouse.move(ends.x2, ends.y2, { steps: 8 });
  await page.mouse.up();
  const button = page.locator(
    '.jp-jupyterlab-lightcone-CommentButton[data-floating]'
  );
  await expect(button).toBeVisible();
  await button.click();
  const popover = page.getByRole('dialog', { name: 'Comment' });
  await popover
    .getByRole('textbox', { name: 'Comment' })
    .fill('Say which data constrain it.');
  const created = page.waitForResponse(
    response =>
      response.url().includes(COMMENTS_API) &&
      response.request().method() === 'POST'
  );
  await page.keyboard.press('Enter');
  expect((await created).status()).toBe(201);

  // The badge sits in the margin beside the quote's line, covering no text.
  const badge = record.locator('.jp-jupyterlab-lightcone-CommentBadge');
  await expect(badge).toHaveText('①');
  const highlight = record
    .locator('.jp-jupyterlab-lightcone-CommentHighlight')
    .first();
  await expect(highlight).toBeVisible();
  const [badgeBox, highlightBox] = await Promise.all([
    badge.boundingBox(),
    highlight.boundingBox()
  ]);
  if (!badgeBox || !highlightBox) {
    throw new Error('The badge or the highlight has no layout box.');
  }
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(ends.column);
  expect(
    Math.abs(
      badgeBox.y +
        badgeBox.height / 2 -
        (highlightBox.y + highlightBox.height / 2)
    )
  ).toBeLessThan(2);

  // The badge opens the comment, which can be deleted from there.
  await badge.click();
  await expect(popover).toContainText('Say which data constrain it.');
  const removed = page.waitForResponse(
    response =>
      response.url().includes(COMMENTS_API) &&
      response.request().method() === 'DELETE'
  );
  await popover.getByRole('button', { name: 'Delete' }).click();
  expect((await removed).status()).toBe(204);
  await expect(badge).toHaveCount(0);
  await expect(page.locator(SIDEBAR)).not.toContainText('pending comment');
});
