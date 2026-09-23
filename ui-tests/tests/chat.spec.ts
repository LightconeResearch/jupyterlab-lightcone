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
  // Inside a project the launcher tab shows Home; the project cards live in
  // the full launcher body.
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:show-launcher'
    );
  });
  await page
    .getByRole('button', { name: 'Lightcone Agent', exact: true })
    .click();
  await expect(page.locator('.jp-chat-input-container')).toBeVisible();
  await expect(
    page.locator('.jp-chat-input-container').getByRole('combobox')
  ).toHaveText('');
  // Sessions open in the main area, never in Jupyter Chat's side panel.
  await expect(
    page.locator('.jp-MainAreaWidget .jp-chat-input-container')
  ).toBeVisible();
  await expect(
    page.locator('[id="JupyterlabChat:sidepanel"] .jp-chat-input-container')
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
  // Reusing a discussion must bring its session back after the user switches away.
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
    page.locator('.jp-MainAreaWidget .jp-chat-input-container')
  ).toBeVisible();
  await expect(
    page.locator('.jp-chat-input-container').getByRole('combobox')
  ).toContainText('outputs.figure');
  // Cards survive a full browser reload and reopening the persisted session;
  // opening it in the main area reveals the restored tab rather than adding
  // a second copy of the conversation.
  await page.reload({ waitForIsReady: false });
  await page.waitForSelector('#jupyterlab-splash', { state: 'detached' });
  await page.evaluate(async filepath => {
    await window.jupyterapp.commands.execute('jupyterlab-chat:open', {
      filepath
    });
  }, `${tmpPath}/chats/untitled.chat`);
  await expect(cards).toHaveCount(2);
  await expect(figure.locator('img')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a chat in a project subfolder sends the message unchanged and roots the agent in the project', async ({
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
name: Chats folder
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
    entrypoint
  );
  await page.contents.createDirectory(`${tmpPath}/chats`);
  // A session is a chat document open in the main area.
  const filepath = await page.evaluate(async directory => {
    const created = await window.jupyterapp.commands.execute(
      'jupyterlab-chat:create',
      { path: directory }
    );
    await window.jupyterapp.commands.execute('jupyterlab-chat:open', {
      filepath: created
    });
    return created;
  }, `${tmpPath}/chats`);
  expect(filepath).toContain(`${tmpPath}/chats/`);
  const composer = page
    .locator('.jp-chat-input-container')
    .getByRole('combobox');
  await composer.fill('Compare the options.');
  // A record shortcut reuses the project's open chat, wherever it is stored.
  const reused = await page.evaluate(
    async args =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:discuss', args),
    { entrypoint, target: 'decisions.method' }
  );
  expect(reused.reused).toBe(true);
  await expect(composer).toContainText('Compare the options.');
  await expect(composer).toContainText(
    'Discuss ASTRA element decisions.method.'
  );
  await page.locator('.jp-chat-send-button').click();
  const received = page
    .locator('.jp-chat-rendered-message')
    .filter({ hasText: 'Agent received:' });
  // Nothing is appended for the agent, and its session starts at the project root.
  await expect(received).toContainText(
    'Discuss ASTRA element decisions.method.] in [',
    { timeout: 30000 }
  );
  await expect(received).toContainText(`in [${tmpPath}]`);
  await expect(
    page
      .locator('.jp-chat-rendered-message')
      .filter({ hasText: 'ASTRA context' })
  ).toHaveCount(0);
  await expect(composer).toHaveText('');
  // The one-argument tools find the project from the chat's location.
  await composer.fill('Show the decision.');
  await page.locator('.jp-chat-send-button').click();
  await expect(page.locator('.jp-jupyterlab-lightcone-element')).toContainText(
    'Stable under perturbations.',
    { timeout: 45000 }
  );
});

test('a chat created outside every project joins the current project and keeps it', async ({
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
    `version: "0.0.14"
name: Current project
inputs: []
outputs: []
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
  // Entering the project folder makes it current, and the server is told.
  const reported = page.waitForResponse(
    response =>
      response.url().includes('/jupyterlab_lightcone/api/current-project') &&
      response.request().method() === 'PUT' &&
      (response.request().postData() ?? '').includes(`${tmpPath}/astra.yaml`)
  );
  await page.filebrowser.openDirectory(tmpPath);
  const status = page.locator('.jp-jupyterlab-lightcone-ProjectStatus');
  await expect(status).toHaveText(
    `Lightcone · ${path.posix.basename(tmpPath)}`
  );
  expect((await reported).ok()).toBe(true);
  // Jupyter Chat's own sidebar action stores the chat at the server root.
  const filepath: string = await page.evaluate(async () => {
    const created = await window.jupyterapp.commands.execute(
      'jupyterlab-chat:create',
      { inSidePanel: true }
    );
    await window.jupyterapp.commands.execute('jupyterlab-chat:open', {
      filepath: created,
      inSidePanel: true
    });
    return created;
  });
  try {
    expect(filepath).not.toContain(tmpPath);
    const composer = page
      .locator('.jp-chat-input-container')
      .getByRole('combobox');
    const received = page
      .locator('.jp-chat-rendered-message')
      .filter({ hasText: 'Agent received:' });
    // The project's own persona loads, and the session starts at the project root.
    await composer.fill('Compare the options.');
    await page.locator('.jp-chat-send-button').click();
    await expect(received).toContainText(`in [${tmpPath}]`, {
      timeout: 30000
    });
    await composer.fill('Show the decision.');
    await page.locator('.jp-chat-send-button').click();
    await expect(
      page.locator('.jp-jupyterlab-lightcone-element')
    ).toContainText('Stable under perturbations.', { timeout: 45000 });
    // Leaving the project hides it from the status bar, but the chat keeps it.
    await page.evaluate(async () => {
      await window.jupyterapp.commands.execute('filebrowser:go-to-path', {
        path: '/',
        dontShowBrowser: true
      });
    });
    await expect(status).toBeHidden();
    await composer.fill('Compare the options.');
    await page.locator('.jp-chat-send-button').click();
    await expect(received).toHaveCount(2, { timeout: 30000 });
    await expect(received.last()).toContainText(`in [${tmpPath}]`);
  } finally {
    await page.contents.deleteFile(filepath);
  }
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

test('Lightcone Agent appears first with a gold chat icon inside an ASTRA project', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'version: "0.0.14"\nname: Launcher project\n',
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.filebrowser.openDirectory(tmpPath);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('launcher:create', { cwd });
    // Inside a project the tab shows Home; the cards live in the full launcher.
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:show-launcher'
    );
  }, tmpPath);
  const shortcut = page.getByRole('button', {
    name: 'Lightcone Agent',
    exact: true
  });
  await expect(
    shortcut.locator('[data-icon="jupyter-chat::chat"]')
  ).toBeVisible();
  const category = `Lightcone Lab · ${tmpPath}`;
  await expect(
    page.locator('.jp-Launcher-sectionTitle:visible').first()
  ).toHaveText(category);
  const section = page
    .locator('.jp-Launcher-section:visible')
    .filter({ hasText: category });
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
    .filter({ hasText: category })
    .locator('.jp-jupyterlab-lightcone-AssistantIcon');
  await expect(sectionIcon).toBeVisible();
  await expect(sectionIcon).toHaveCSS('background-image', /url\(.+\)/);
  await expect(sectionIcon.locator('svg')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({
    path: test.info().outputPath('lightcone-launcher.png')
  });
});

test('Lightcone Agent offers project setup outside an ASTRA project without creating a chat', async ({
  page,
  tmpPath
}) => {
  await page.filebrowser.openDirectory(tmpPath);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('launcher:create', { cwd });
  }, tmpPath);
  const section = page
    .locator('.jp-Launcher-section:visible')
    .filter({ hasText: 'Lightcone Lab' });
  await expect(
    section.getByRole('button', {
      name: 'New Lightcone project',
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Lightcone Agent', exact: true })
  ).toHaveCount(0);
  const writes: string[] = [];
  page.on('request', request => {
    if (
      ['POST', 'PUT'].includes(request.method()) &&
      request.url().includes('/api/contents')
    )
      writes.push(request.url());
  });
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:discuss', {
      cwd
    });
  }, tmpPath);
  await expect(page.locator('#lightcone-project-folder')).toHaveValue(tmpPath);
  await expect(page.locator('.jp-chat-input-container')).toHaveCount(0);
  expect(writes).toEqual([]);
});
