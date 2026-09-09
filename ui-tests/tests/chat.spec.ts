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
        insights: [support]
    default: robust
    rationale: Stable under perturbations.
prior_insights:
  support:
    label: Supporting evidence
    claim: Repeated trials favor the robust estimator.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: 10.1234/continuous-test
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
    .getByRole('button', { name: 'Lightcone Agent', exact: true })
    .click();
  await expect(page.locator('.jp-chat-input-container')).toBeVisible();
  await expect(
    page.locator('.jp-chat-input-container').getByRole('combobox')
  ).toHaveText('');
  await expect(
    page.locator('[id="JupyterlabChat:sidepanel"] .jp-chat-input-container')
  ).toBeVisible();
  await expect(
    page.locator('.jp-MainAreaWidget .jp-chat-input-container')
  ).toHaveCount(0);
  await expect(page.locator('.jp-chat-send-button')).toBeDisabled();
  await page
    .locator('.jp-chat-input-container')
    .getByRole('combobox')
    .fill('Show the decision and figure.');
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
  const figure = cards.filter({
    has: page.getByRole('link', {
      name: 'Open outputs.figure in a tab',
      exact: true
    })
  });
  await expect(figure.locator('img')).toBeVisible();
  // Streaming replies can still scroll the card away from the pointer.
  await expect(
    page
      .locator('.jp-chat-rendered-message code')
      .filter({ hasText: '{astra}`outputs.figure`' })
  ).toBeVisible();
  await expect(page.locator('.jp-chat-writers')).not.toContainText(
    'Lightcone test agent'
  );
  // The raised top edge must stay visible and clickable outside its old bounds.
  await figure.hover();
  await expect(figure).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -2)');
  expect(
    await figure.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 1)
      );
    })
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('raised-chat-card.png')
  });
  await expect(cards.getByText('Open in tab', { exact: true })).toHaveCount(0);
  await expect(cards.filter({ hasText: `${tmpPath}/astra.yaml` })).toHaveCount(
    0
  );
  const decision = cards.filter({ hasText: 'Which estimator?' });
  await page.evaluate(() => {
    document.body.dataset.cardTargets = '[]';
    window.jupyterapp.commands.commandExecuted.connect((_sender, args) => {
      if (args.id === 'jupyterlab_lightcone:open-element') {
        const targets: string[] = JSON.parse(
          document.body.dataset.cardTargets!
        );
        targets.push(String(args.args.target));
        document.body.dataset.cardTargets = JSON.stringify(targets);
      }
    });
  });
  // Related-record controls must not also open (or pin) their parent card.
  const related = decision.getByRole('button', { name: /Supporting evidence/ });
  await related.click();
  await expect(
    page.locator('.jp-jupyterlab-lightcone-element:visible')
  ).toContainText('Repeated trials favor the robust estimator.');
  await related.press('Enter');
  await expect(page.locator('body')).toHaveAttribute(
    'data-card-targets',
    JSON.stringify(['prior_insights.support', 'prior_insights.support'])
  );
  // Selecting prose remains useful for copying it out of the conversation.
  const prose = decision.locator('.astra-record-preview__description');
  await prose.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await prose.dispatchEvent('click');
  expect(
    await page.evaluate(() => window.getSelection()?.toString())
  ).toContain('Stable');
  await expect(page.locator('body')).toHaveAttribute(
    'data-card-targets',
    JSON.stringify(['prior_insights.support', 'prior_insights.support'])
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
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
    body: await page.screenshot({
      path: test.info().outputPath('chat-mime-cards.png')
    }),
    contentType: 'image/png'
  });
  await figure.locator('img').click();
  await expect(
    page
      .locator('.jp-jupyterlab-lightcone-element')
      .filter({ hasText: 'outputs.figure' })
  ).toBeVisible();
  await expect(
    page.locator('.jp-jupyterlab-lightcone-reference-button')
  ).toHaveCount(0);
  if (process.env.LIGHTCONE_TEST_MYST === '1') {
    await expect(
      page.locator('.jp-chat-rendered-message .jp-RenderedMySTMarkdown').first()
    ).toBeVisible();
  } else {
    await expect(page.locator('.jp-RenderedMySTMarkdown')).toHaveCount(0);
    await expect(
      page.locator('.jp-chat-rendered-message .jp-RenderedMarkdown').first()
    ).toBeVisible();
  }
  const decisionLink = decision.getByRole('link', {
    name: /Open Which estimator/
  });
  await decisionLink.press('Enter');
  await expect(
    page.locator('.jp-jupyterlab-lightcone-element:visible')
  ).toContainText('Stable under perturbations.');
  await figure.locator('img').dblclick();
  await expect(
    page
      .locator('.jp-jupyterlab-lightcone-element:visible')
      .getByRole('button', { name: 'Unpin tab', exact: true })
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

test('empty chats send their bound universe with the user message and preserve reused drafts', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
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
name: Multiple universes
inputs: []
outputs: []
decisions:
  method:
    label: Which estimator?
    options:
      robust:
        label: Robust estimator
      fast:
        label: Fast estimator
    default: robust
`,
    'text',
    entrypoint
  );
  for (const [id, option] of [
    ['baseline', 'robust'],
    ['alternate', 'fast']
  ])
    await page.contents.uploadContent(
      `id: ${id}\ndecisions:\n  method: ${option}\n`,
      'text',
      `${tmpPath}/universes/${id}.yaml`
    );
  const composer = page
    .locator('.jp-chat-input-container')
    .getByRole('combobox');
  const chatIds = new Set<string>();
  for (const universeId of ['baseline', 'alternate']) {
    const context = await page.evaluate(
      async args =>
        window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:discuss',
          args
        ),
      { entrypoint, universeId }
    );
    expect(context.universeId).toBe(universeId);
    chatIds.add(context.chatId);
    await expect(composer).toHaveText('');
    await composer.fill('Compare the options.');
    const reused = await page.evaluate(
      async args =>
        window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:discuss',
          args
        ),
      { entrypoint, universeId, target: 'decisions.method' }
    );
    expect(reused.reused).toBe(true);
    await expect(composer).toContainText('Compare the options.');
    await expect(composer).toContainText(
      'Discuss ASTRA element decisions.method.'
    );
    await expect(composer).not.toContainText('ASTRA context:');
    await page.locator('.jp-chat-send-button').click();
    const received = page
      .locator('.jp-chat-rendered-message')
      .filter({ hasText: 'Agent received:' });
    await expect(received).toContainText(
      new RegExp(`Use the bound universe ["“]${universeId}["”]`),
      { timeout: 30000 }
    );
    await expect(received).toContainText(entrypoint);
    await expect(composer).toHaveText('');
  }
  expect(chatIds.size).toBe(2);
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

test('Lightcone Agent appears first with a gold chat icon and explains a missing ASTRA project without creating a chat', async ({
  page,
  tmpPath
}) => {
  await page.filebrowser.openDirectory(tmpPath);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('launcher:create', { cwd });
  }, tmpPath);
  const shortcut = page.getByRole('button', {
    name: 'Lightcone Agent',
    exact: true
  });
  await expect(
    shortcut.locator('[data-icon="jupyter-chat::chat"]')
  ).toBeVisible();
  await expect(
    page.locator('.jp-Launcher-sectionTitle:visible').first()
  ).toHaveText('Lightcone Lab');
  const section = page
    .locator('.jp-Launcher-section:visible')
    .filter({ hasText: 'Lightcone Lab' });
  await expect(section.getByRole('button').first()).toHaveAccessibleName(
    'Lightcone Agent'
  );
  const agentGlyph = shortcut.locator('.jp-icon3');
  await expect(agentGlyph).toHaveCSS('fill', 'rgb(166, 124, 60)');
  await page.theme.setDarkTheme();
  await expect(agentGlyph).toHaveCSS('fill', 'rgb(166, 124, 60)');
  await expect(
    page.getByRole('button', { name: 'Chat', exact: true }).locator('.jp-icon3')
  ).not.toHaveCSS('fill', 'rgb(166, 124, 60)');
  await page.theme.setLightTheme();
  const sectionIcon = page
    .locator('.jp-Launcher-sectionHeader:visible')
    .filter({ hasText: 'Lightcone Lab' })
    .locator('.jp-jupyterlab-lightcone-AssistantIcon');
  await expect(sectionIcon).toBeVisible();
  await expect(sectionIcon).toHaveCSS('background-image', /url\(.+\)/);
  await expect(sectionIcon.locator('svg')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({
    path: test.info().outputPath('lightcone-launcher.png')
  });
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
