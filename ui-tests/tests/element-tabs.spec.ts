import { expect, test } from '@jupyterlab/galata';

const project = `version: "0.0.14"
name: Tab project
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
  sample:
    label: Which sample?
    options:
      full:
        label: Full sample
    default: full
    rationale: Retain all observations.
  scale:
    label: Which scale?
    options:
      log:
        label: Log scale
    default: log
    rationale: Resolve the tails.
`;

const tabs = '.lm-TabBar-tab[data-lightcone-element]';
const viewer = '.jp-jupyterlab-lightcone-element';

test.beforeEach(async ({ page, tmpPath }) => {
  await page.contents.uploadContent(project, 'text', `${tmpPath}/astra.yaml`);
});

test('reuses a preview and retains explicitly pinned native tabs in the same group', async ({
  page,
  tmpPath
}) => {
  const open = (target: string) =>
    page.evaluate(
      async args =>
        window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:open-element',
          args
        ),
      { entrypoint: `${tmpPath}/astra.yaml`, target }
    );
  const first = await open('decisions.method');
  await expect(page.locator(tabs)).toHaveCount(1);
  await expect(page.locator(`${tabs} .lm-TabBar-tabLabel`)).toHaveCSS(
    'font-style',
    'italic'
  );
  const second = await open('decisions.sample');
  expect(second.widgetId).toBe(first.widgetId);
  await expect(page.locator(viewer)).toContainText('Retain all observations.');
  await page.locator(`${tabs} .lm-TabBar-tabLabel`).dblclick();
  await expect(
    page.getByRole('button', { name: 'Pinned', exact: true })
  ).toBeVisible();
  await expect(page.locator(`${tabs} .lm-TabBar-tabLabel`)).toHaveCSS(
    'font-style',
    'normal'
  );
  const third = await open('decisions.scale');
  expect(third.widgetId).not.toBe(first.widgetId);
  await expect(page.locator(tabs)).toHaveCount(2);
  expect(
    await page
      .locator(tabs)
      .evaluateAll(nodes => nodes[0].parentElement === nodes[1].parentElement)
  ).toBe(true);
  const same = await open('decisions.sample');
  expect(same.reused).toBe(true);
  expect(same.pinned).toBe(true);
  const fourth = await open('decisions.method');
  expect(fourth.widgetId).toBe(third.widgetId);
  await page
    .locator(`${viewer}:visible`)
    .getByRole('button', { name: 'Pin tab', exact: true })
    .click();
  const fifth = await open('decisions.scale');
  expect(fifth.widgetId).not.toBe(third.widgetId);
  await expect(page.locator(tabs)).toHaveCount(3);
  // Pinning protects identity, while shared project data still refreshes.
  await page.contents.uploadContent(
    project.replace('Stable under perturbations.', 'Updated rationale.'),
    'text',
    `${tmpPath}/astra.yaml`
  );
  await open('decisions.method');
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'Updated rationale.'
  );
  await page.screenshot({ path: test.info().outputPath('native-tabs.png') });
  await test.info().attach('native-tabs', {
    path: test.info().outputPath('native-tabs.png'),
    contentType: 'image/png'
  });
  await page
    .locator(
      `[data-lightcone-element="${first.widgetId}"] .lm-TabBar-tabCloseIcon`
    )
    .click();
  await expect(page.locator(tabs)).toHaveCount(2);
});

test('pins from the native tab context menu, and preserves both tabs on reload', async ({
  page,
  tmpPath
}) => {
  const first = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.method'
      }),
    `${tmpPath}/astra.yaml`
  );
  await page.locator(tabs).click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Pin ASTRA tab', exact: true })
    .click();
  const second = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.sample'
      }),
    `${tmpPath}/astra.yaml`
  );
  await expect(page.locator(tabs)).toHaveCount(2);
  // Wait for the workspace save rather than relying on a fixed sleep.
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        JSON.stringify(await window.jupyterapp.serviceManager.workspaces.list())
      )
    )
    .toContain(second.widgetId);
  await page.contents.uploadContent(
    project.replace('  method:', '  renamed:'),
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.reload({ waitForIsReady: false });
  await page.waitForSelector('#jupyterlab-splash', { state: 'detached' });
  await expect(page.locator(tabs)).toHaveCount(2);
  await expect(
    page.locator(`[data-lightcone-element="${first.widgetId}"]`)
  ).toHaveClass(/pinned-tab/);
  await expect(
    page.locator(`[data-lightcone-element="${second.widgetId}"]`)
  ).toHaveClass(/preview-tab/);
  const third = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.scale'
      }),
    `${tmpPath}/astra.yaml`
  );
  expect(third.widgetId).toBe(second.widgetId);
  await page.locator(`[data-lightcone-element="${first.widgetId}"]`).click();
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'no longer available'
  );
  await page.contents.uploadContent(project, 'text', `${tmpPath}/astra.yaml`);
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'Stable under perturbations.'
  );
});

test('serializes concurrent opens, isolates projects and pins manually split views', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    project,
    'text',
    `${tmpPath}/other/astra.yaml`
  );
  const results = await page.evaluate(
    async entrypoint =>
      Promise.all(
        ['method', 'sample', 'scale'].map(key =>
          window.jupyterapp.commands.execute(
            'jupyterlab_lightcone:open-element',
            { entrypoint, target: `decisions.${key}` }
          )
        )
      ),
    `${tmpPath}/astra.yaml`
  );
  expect(new Set(results.map(result => result.widgetId)).size).toBe(1);
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'Resolve the tails.'
  );
  const other = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.method'
      }),
    `${tmpPath}/other/astra.yaml`
  );
  expect(other.widgetId).not.toBe(results[0].widgetId);
  // Opening immediately after a move must not race the shell's deferred notification.
  const next = await page.evaluate(
    async ({ id, entrypoint }) => {
      const shell = window.jupyterapp.shell;
      const widget = Array.from(shell.widgets('main')).find(
        item => item.id === id
      )!;
      shell.moveTab(widget, 'right');
      return window.jupyterapp.commands.execute(
        'jupyterlab_lightcone:open-element',
        { entrypoint, target: 'decisions.method' }
      );
    },
    { id: results[0].widgetId, entrypoint: `${tmpPath}/astra.yaml` }
  );
  await expect(
    page.locator(`[data-lightcone-element="${results[0].widgetId}"]`)
  ).toHaveClass(/pinned-tab/);
  expect(next.widgetId).not.toBe(results[0].widgetId);
  await expect(page.locator(tabs)).toHaveCount(3);
});

test('keeps separate previews for explicit universes', async ({
  page,
  tmpPath
}) => {
  for (const id of ['baseline', 'alternate'])
    await page.contents.uploadContent(
      `id: ${id}\ndecisions:\n  method: robust\n  sample: full\n  scale: log\n`,
      'text',
      `${tmpPath}/universes/${id}.yaml`
    );
  const result = await page.evaluate(async entrypoint => {
    const open = (target: string, universeId: string) =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target,
        universeId
      });
    const a = await open('decisions.method', 'baseline');
    const b = await open('decisions.method', 'alternate');
    const c = await open('decisions.sample', 'baseline');
    return { a, b, c };
  }, `${tmpPath}/astra.yaml`);
  expect(result.a.widgetId).not.toBe(result.b.widgetId);
  expect(result.c.widgetId).toBe(result.a.widgetId);
  await expect(page.locator(tabs)).toHaveCount(2);
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'Universe: baseline'
  );
});

test('adapts figure and decision details to narrow panels and the dark theme', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="#eee"/><path d="M20 280L110 210L200 180L290 60L380 95L470 40L580 20" stroke="#7865c6" stroke-width="5" fill="none"/></svg>',
    'text',
    `${tmpPath}/results/default/figure.svg`
  );
  await page.evaluate(async entrypoint => {
    const opened = await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-element',
      { entrypoint, target: 'outputs.figure' }
    );
    for (const widget of Array.from(window.jupyterapp.shell.widgets('main')))
      if (widget.id !== opened.widgetId) widget.close();
  }, `${tmpPath}/astra.yaml`);
  await expect(page.locator(`${viewer} img`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('figure-wide.png') });
  await test.info().attach('figure-wide', {
    path: test.info().outputPath('figure-wide.png'),
    contentType: 'image/png'
  });
  await page.setViewportSize({ width: 850, height: 800 });
  await expect
    .poll(async () => {
      const result = await page
        .locator(`${viewer} .astra-output-detail__result`)
        .boundingBox();
      const provenance = await page
        .locator(`${viewer} .astra-output-detail__provenance`)
        .boundingBox();
      return (
        !!result && !!provenance && provenance.y >= result.y + result.height - 1
      );
    })
    .toBe(true);
  await page.getByRole('button', { name: 'View figure full screen' }).click();
  const fullscreen = page.getByRole('dialog', {
    name: 'Full-screen figure: figure',
    exact: true
  });
  await expect(fullscreen).toBeVisible();
  await expect
    .poll(async () => fullscreen.boundingBox())
    .toEqual({ x: 0, y: 0, width: 850, height: 800 });
  await page.keyboard.press('Escape');
  await expect(fullscreen).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pin tab', exact: true })
  ).toBeEnabled();
  await page.evaluate(async () =>
    window.jupyterapp.commands.execute('apputils:change-theme', {
      theme: 'JupyterLab Dark'
    })
  );
  await expect(page.locator('body')).toHaveAttribute(
    'data-jp-theme-name',
    'JupyterLab Dark'
  );
  await page.screenshot({
    path: test.info().outputPath('figure-narrow-dark.png')
  });
  await test.info().attach('figure-narrow-dark', {
    path: test.info().outputPath('figure-narrow-dark.png'),
    contentType: 'image/png'
  });
  await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.method'
      }),
    `${tmpPath}/astra.yaml`
  );
  await expect(page.locator(viewer)).toContainText(
    'Stable under perturbations.'
  );
  expect(
    await page
      .locator(viewer)
      .evaluate(node => node.scrollWidth <= node.clientWidth)
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('decision-narrow-dark.png')
  });
  await test.info().attach('decision-narrow-dark', {
    path: test.info().outputPath('decision-narrow-dark.png'),
    contentType: 'image/png'
  });
});

test('honors a pin while an earlier queued open is waiting for project data', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    project,
    'text',
    `${tmpPath}/slow/astra.yaml`
  );
  const first = await page.evaluate(
    async entrypoint =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint,
        target: 'decisions.method'
      }),
    `${tmpPath}/astra.yaml`
  );
  let release: () => void = () => undefined;
  let received: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const waiting = new Promise<void>(resolve => {
    received = resolve;
  });
  await page.route(
    `**/api/contents/${tmpPath}/slow/astra.yaml?*`,
    async route => {
      received();
      await gate;
      await route.continue();
    }
  );
  const pending = page.evaluate(async directory => {
    const commands = window.jupyterapp.commands;
    return Promise.all([
      commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint: `${directory}/slow/astra.yaml`,
        target: 'decisions.scale'
      }),
      commands.execute('jupyterlab_lightcone:open-element', {
        entrypoint: `${directory}/astra.yaml`,
        target: 'decisions.sample'
      })
    ]);
  }, tmpPath);
  try {
    await waiting;
    await page
      .locator(`${viewer}:visible`)
      .getByRole('button', { name: 'Pin tab', exact: true })
      .click();
  } finally {
    release();
  }
  const [, next] = await pending;
  expect(next.widgetId).not.toBe(first.widgetId);
  await expect(
    page.locator(`[data-lightcone-element="${first.widgetId}"]`)
  ).toHaveClass(/pinned-tab/);
  await page.locator(`[data-lightcone-element="${first.widgetId}"]`).click();
  await expect(page.locator(`${viewer}:visible`)).toContainText(
    'Stable under perturbations.'
  );
});
