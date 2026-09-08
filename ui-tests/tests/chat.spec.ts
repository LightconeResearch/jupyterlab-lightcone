import { expect, test } from '@jupyterlab/galata';
import fs from 'node:fs';
import path from 'node:path';

test('agent publishes MIME cards and opens a native decision tab through MCP', async ({
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
  await page.filebrowser.openDirectory(tmpPath);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('launcher:create', { cwd });
  }, tmpPath);
  await page
    .getByRole('button', { name: 'Agentic assistant', exact: true })
    .click();
  await expect(page.locator('.jp-chat-input-container')).toBeVisible();
  await expect(
    page.locator('[id="JupyterlabChat:sidepanel"] .jp-chat-input-container')
  ).toBeVisible();
  await expect(
    page.locator('.jp-MainAreaWidget .jp-chat-input-container')
  ).toHaveCount(0);
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
  const cards = page.locator('.jp-jupyterlab-lightcone-card');
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  const figure = cards.filter({ hasText: 'outputs.figure' });
  await expect(figure.locator('img')).toBeVisible();
  // Chat owns only the DOM node: removal must unmount React and release leases.
  const cleaned = await figure.evaluate(async node => {
    const host = node.closest('lightcone-astra-card')!;
    const parent = host.parentNode!;
    const next = host.nextSibling;
    host.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    const empty = host.childNodes.length === 0;
    parent.insertBefore(host, next);
    return empty;
  });
  expect(cleaned).toBe(true);
  await expect(figure.locator('img')).toBeVisible();
  await test.info().attach('chat-mime-cards', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await figure
    .getByRole('button', { name: 'Open in tab', exact: true })
    .click();
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
  await expect(
    page.locator('.jp-jupyterlab-lightcone-reference-button')
  ).toHaveCount(0);
  if (process.env.LIGHTCONE_TEST_MYST === '1')
    await expect(
      page.locator('.jp-RenderedMySTMarkdown').first()
    ).toBeVisible();
  await figure
    .getByRole('button', { name: 'Open in tab', exact: true })
    .dblclick();
  await expect(
    page
      .locator('.jp-jupyterlab-lightcone-element:visible')
      .getByRole('button', { name: 'Pinned', exact: true })
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
  // Reusing a discussion must reveal its sidebar after the user switches away.
  await page.getByRole('tab', { name: /File Browser/ }).click();
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
    page.locator('[id="JupyterlabChat:sidepanel"] .jp-chat-input-container')
  ).toBeVisible();
  await expect(
    page.locator('.jp-chat-input-container').getByRole('combobox')
  ).toContainText('outputs.figure');
  // The binding survives a full browser reload and reopening the persisted chat.
  await page.reload({ waitForIsReady: false });
  await page.waitForSelector('#jupyterlab-splash', { state: 'detached' });
  await page.evaluate(async filepath => {
    await window.jupyterapp.commands.execute('jupyterlab-chat:open', {
      filepath,
      inSidePanel: true
    });
  }, `${tmpPath}/untitled.chat`);
  await expect(cards).toHaveCount(2);
  await expect(figure.locator('img')).toBeVisible();
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
        quote:
          exact: A reproducible result appears on the final page.
        location:
          page: 3
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
  await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'prior_insights.precedent'
      }),
    `${tmpPath}/astra.yaml`
  );
  await page.getByRole('button', { name: 'Locate passage in paper' }).click();
  const pdf = page.getByRole('group', {
    name: 'PDF viewer for Continuous scrolling test paper',
    exact: true
  });
  await expect(pdf.getByRole('status')).toHaveText(
    'Quote highlighted on page 3 of 3'
  );
  await expect(
    page.getByRole('heading', {
      name: 'Continuous scrolling test paper',
      exact: true
    })
  ).toBeInViewport();
  await expect(
    pdf.getByRole('button', { name: 'Zoom PDF in', exact: true })
  ).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('native-paper.png') });
  await test.info().attach('native-paper', {
    path: test.info().outputPath('native-paper.png'),
    contentType: 'image/png'
  });
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

test('Agentic assistant uses the chat icon and explains a missing ASTRA project without creating a chat', async ({
  page,
  tmpPath
}) => {
  await page.filebrowser.openDirectory(tmpPath);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('launcher:create', { cwd });
  }, tmpPath);
  const shortcut = page.getByRole('button', {
    name: 'Agentic assistant',
    exact: true
  });
  await expect(
    shortcut.locator('[data-icon="jupyter-chat::chat"]')
  ).toBeVisible();
  const sectionIcon = page
    .locator('.jp-Launcher-sectionHeader:visible')
    .filter({ hasText: 'Lightcone Lab' })
    .locator('.jp-jupyterlab-lightcone-AssistantIcon');
  await expect(sectionIcon).toBeVisible();
  await expect(sectionIcon).toHaveCSS('background-image', /url\(.+\)/);
  await expect(sectionIcon.locator('svg')).toHaveCSS('visibility', 'hidden');
  const writes: string[] = [];
  page.on('request', request => {
    if (
      ['POST', 'PUT'].includes(request.method()) &&
      request.url().includes('/api/contents')
    )
      writes.push(request.url());
  });
  await shortcut.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No ASTRA project found');
  await expect(dialog).toContainText(`${tmpPath}/astra.yaml`);
  await expect(dialog).toContainText('Open a folder containing astra.yaml');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.jp-chat-input-container')).toHaveCount(0);
  expect(writes).toEqual([]);
});
