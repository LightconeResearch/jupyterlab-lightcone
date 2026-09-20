import { expect, test } from '@jupyterlab/galata';

test('shows three result states, clears them on service failure, and recovers', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(
    `version: '0.0.14'
name: Materialization preview
inputs: []
outputs:
  - id: plot
    type: figure
    format: svg
  - id: value
    type: metric
    format: json
  - id: data
    type: data
    format: json
`,
    'text',
    entrypoint
  );
  let unavailable = false;
  let currentOnly = true;
  await page.route(
    '**/jupyterlab_lightcone/api/materialization?*',
    async route => {
      await route.fulfill({
        status: unavailable ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          unavailable
            ? {
                message:
                  "Lightcone could not read this project's status:\nuv is required (the environment substrate)."
              }
            : {
                outputs: {
                  'default/plot': {
                    state: currentOnly ? 'current' : 'stale',
                    detail: 'the recipe changed'
                  },
                  'default/value': {
                    state: currentOnly ? 'current' : 'behind',
                    detail: 'the environment changed'
                  },
                  'default/data': {
                    state: currentOnly ? 'current' : 'stale',
                    detail: 'no manifest'
                  }
                }
              }
        )
      });
    }
  );
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-inventory',
      { path }
    );
  }, entrypoint);
  const results = page.locator(
    '[data-slot="output-card"], [data-slot="output-entry"]'
  );
  await expect(results).toHaveCount(3);
  const sizes = () =>
    results.evaluateAll(elements =>
      elements.map(element => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height };
      })
    );
  await page.evaluate(() => document.fonts.ready);
  const originalSizes = await sizes();
  currentOnly = false;
  await page.evaluate(async path => {
    await window.jupyterapp.serviceManager.contents.save(path, {
      type: 'file',
      format: 'text',
      content: '# update status'
    });
  }, `${tmpPath}/script.py`);
  await expect(page.getByRole('img', { name: /^Stale: / })).toHaveCount(2);
  await expect(
    page.getByRole('img', {
      name: 'Behind: the environment changed',
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Stale: the recipe changed' })
  ).toBeVisible();
  // Markers overlay results without shifting them; a stale metric with no
  // artifact is the one entry astra-ui redraws, so the metric here is behind.
  expect(await sizes()).toEqual(originalSizes);
  // File markers belong inside their row; cards and pills keep the corner overlay.
  for (const result of await results.all()) {
    const box = (await result.boundingBox())!;
    const marker = result.locator('.astra-output-status');
    const corner = (await marker.boundingBox())!;
    if ((await result.getAttribute('data-kind')) === 'file') {
      expect(corner.x).toBeGreaterThan(box.x);
      expect(corner.x + corner.width).toBeLessThan(box.x + box.width);
      expect(
        Math.abs(corner.y + corner.height / 2 - box.y - box.height / 2)
      ).toBeLessThanOrEqual(1);
    } else {
      expect(
        Math.abs(corner.x + corner.width / 2 - box.x - box.width)
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(corner.y + corner.height / 2 - box.y)
      ).toBeLessThanOrEqual(2);
    }
    await marker.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(
      (await marker.getAttribute('aria-label'))!
    );
    const tip = (await tooltip.boundingBox())!;
    expect(tip.x).toBeGreaterThanOrEqual(0);
    expect(tip.x + tip.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
  }
  await expect(page.getByText('Current', { exact: true })).toHaveCount(0);
  await expect(results.locator('[data-slot="kind-glyph"]')).toHaveCount(0);
  const error = page.getByText('Materialization status unavailable', {
    exact: true
  });
  await expect(error).toHaveCount(0);
  unavailable = true;
  // A local file event requests status again without changing the analysis.
  await page.evaluate(async path => {
    await window.jupyterapp.serviceManager.contents.save(path, {
      type: 'file',
      format: 'text',
      content: '# changed'
    });
  }, `${tmpPath}/script.py`);
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('title', /uv is required/);
  await expect(page.locator('.astra-output-status')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open figure: plot', exact: true })
  ).toBeVisible();
  unavailable = false;
  await page.evaluate(async path => {
    await window.jupyterapp.serviceManager.contents.save(path, {
      type: 'file',
      format: 'text',
      content: '# changed again'
    });
  }, `${tmpPath}/script.py`);
  await expect(page.locator('.astra-output-status')).toHaveCount(3);
  await expect(error).toHaveCount(0);
});
