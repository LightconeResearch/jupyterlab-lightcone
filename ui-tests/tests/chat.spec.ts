import { expect, test } from '@jupyterlab/galata';
import fs from 'node:fs';
import path from 'node:path';

test('agent streams rich references and opens a native decision tab through MCP', async ({
  page,
  tmpPath,
  browser,
  baseURL
}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.contents.uploadContent(
    fs.readFileSync(
      path.resolve(__dirname, '../fixtures/personas/lightcone_persona.py'),
      'utf8'
    ),
    'text',
    `${tmpPath}/.jupyter/personas/lightcone_persona.py`
  );
  await page.contents.uploadContent(
    `version: "0.0.14"
name: Chat project
inputs: []
outputs:
  - id: figure
    type: figure
    format: svg
decisions:
  method:
    label: Which estimator?
    options:
      robust:
        label: Robust estimator
    default: robust
    rationale: Stable under perturbations.
`,
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.contents.uploadContent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="gold"/></svg>',
    'text',
    `${tmpPath}/results/default/figure.svg`
  );
  await page.evaluate(async entrypoint => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:discuss', {
      entrypoint
    });
  }, `${tmpPath}/astra.yaml`);
  await expect(page.locator('.jp-chat-input-container')).toBeVisible();
  await expect(page.locator('.jp-chat-send-button')).toBeEnabled();
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto(`${baseURL}/lab/workspaces/lightcone-routing?reset`);
  await otherPage.waitForFunction(() =>
    window.jupyterapp?.commands.hasCommand('jupyterlab_lightcone:open-element')
  );
  await otherPage.evaluate(() => {
    window.jupyterapp.commands.commandExecuted.connect((_sender, args) => {
      if (args.id === 'jupyterlab_lightcone:open-element')
        document.body.dataset.unexpectedLightconeOpen = 'true';
    });
  });
  await page.locator('.jp-chat-send-button').click();
  await expect(page.locator('.jp-jupyterlab-lightcone-element')).toContainText(
    'Stable under perturbations.',
    { timeout: 45000 }
  );
  const reference = page.getByRole('button', {
    name: 'Open the figure',
    exact: true
  });
  await expect(reference).toBeVisible({ timeout: 30000 });
  await reference.hover();
  await expect(page.locator('[data-slot="preview-popover"]')).toBeVisible();
  await expect(page.locator('[data-slot="preview-popover"] img')).toBeVisible();
  await test.info().attach('chat-preview', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await page.keyboard.press('Escape');
  await reference.click();
  await expect(
    page
      .locator('.jp-jupyterlab-lightcone-element')
      .filter({ hasText: 'outputs.figure' })
  ).toBeVisible();
  await expect(
    page
      .locator('.jp-chat-rendered-message code')
      .filter({ hasText: '{astra}`outputs.figure`' })
  ).toBeVisible();
  const result = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'outputs.figure'
      }),
    `${tmpPath}/astra.yaml`
  );
  expect(result.reused).toBe(true);
  expect(
    await otherPage
      .locator('body')
      .getAttribute('data-unexpected-lightcone-open')
  ).toBeNull();
  await otherContext.close();
  const added = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:discuss', {
        entrypoint,
        target: 'outputs.figure'
      }),
    `${tmpPath}/astra.yaml`
  );
  expect(added.reused).toBe(true);
  await expect(
    page.locator('.jp-chat-input-container').getByRole('combobox')
  ).toContainText('{astra}`outputs.figure`');
  // The binding survives a full browser reload and reopening the persisted chat.
  await page.reload({ waitForIsReady: false });
  await page.waitForSelector('#jupyterlab-splash', { state: 'detached' });
  await page.evaluate(async filepath => {
    await window.jupyterapp.commands.execute('jupyterlab-chat:open', {
      filepath,
      inSidePanel: false
    });
  }, `${tmpPath}/untitled.chat`);
  await expect(
    page.getByRole('button', { name: 'Open the figure', exact: true })
  ).toBeVisible();
  await expect(
    page.locator('.jp-jupyterlab-lightcone-chat-context')
  ).toContainText('defaults');
  expect(errors).toEqual([]);
});

test('opens only cited papers as native tabs without downloading them', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    `version: "0.0.14"
name: Papers
inputs: []
outputs: []
prior_insights:
  precedent:
    claim: A cached result.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: 10.1234/continuous-test
`,
    'text',
    `${tmpPath}/astra.yaml`
  );
  const result = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: '',
        doi: '10.1234/continuous-test'
      }),
    `${tmpPath}/astra.yaml`
  );
  expect(result.view).toBe('element');
  await expect(
    page.locator('.jp-jupyterlab-lightcone-element canvas').first()
  ).toBeVisible();
  const missing = await page.evaluate(async entrypoint => {
    try {
      await window.jupyterapp.commands.execute(
        'jupyterlab_lightcone:open-element',
        { entrypoint, target: '', doi: '10.1234/missing' }
      );
    } catch (reason) {
      return String(reason);
    }
    return '';
  }, `${tmpPath}/astra.yaml`);
  expect(missing).toContain('not cited');
});
