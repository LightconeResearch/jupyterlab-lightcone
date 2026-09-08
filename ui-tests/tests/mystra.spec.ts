import { expect, test } from '@jupyterlab/galata';

const template = process.env.MYSTRA_TEST_TEMPLATE;
const command = 'jupyterlab_lightcone:open-mystra';

test.describe('MySTRA Viewer with the actual CLI and theme', () => {
  test.skip(
    !template,
    'Set MYSTRA_TEST_TEMPLATE to a built ASTRA article or book template.'
  );
  test.setTimeout(180000);

  test('opens, reuses, navigates, reloads saved content, and restarts', async ({
    page,
    tmpPath
  }) => {
    const directory = `${tmpPath}/publication`;
    await page.contents.createDirectory(directory);
    await page.contents.uploadContent(
      `version: 1\nproject:\n  title: Viewer integration\n  toc:\n    - file: index.md\n    - file: methods.md\nsite:\n  template: ${JSON.stringify(template)}\n`,
      'text',
      `${directory}/myst.yml`
    );
    await page.contents.uploadContent(
      '# Viewer integration\n\n[Methods](methods.md)\n',
      'text',
      `${directory}/index.md`
    );
    await page.contents.uploadContent(
      '# Methods\n\nOriginal methods.\n',
      'text',
      `${directory}/methods.md`
    );
    const blocked: string[] = [];
    const server = new URL(page.url());
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.port !== server.port
      ) {
        blocked.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.routeWebSocket('**/*', route => {
      const url = new URL(route.url());
      if (
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.port !== server.port
      ) {
        blocked.push(url.href);
        route.close();
      } else route.connectToServer();
    });
    const open = () =>
      page.evaluate(
        async ({ command, path }) => {
          const viewer = await window.jupyterapp.commands.execute(command, {
            path
          });
          return viewer?.id;
        },
        { command, path: directory }
      );
    try {
      const id = await open();
      expect(id).toBeTruthy();
      const viewer = page.locator(`[id="${id}"]`);
      await expect(viewer.getByRole('status')).toHaveText(
        'MySTRA viewer is running',
        { timeout: 120000 }
      );
      const frame = viewer.frameLocator('iframe');
      await expect(
        frame
          .getByRole('heading', { name: 'Viewer integration', exact: true })
          .first()
      ).toBeVisible();
      expect(await open()).toBe(id);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await frame
        .locator('a[href$="/methods"]')
        .filter({ visible: true })
        .first()
        .click({ timeout: 10000 });
      await expect(
        frame.getByText('Original methods.', { exact: true })
      ).toBeVisible();
      await page.contents.uploadContent(
        '# Methods\n\nUpdated methods from disk.\n',
        'text',
        `${directory}/methods.md`
      );
      await expect(
        frame.getByText('Updated methods from disk.', { exact: true })
      ).toBeVisible({ timeout: 20000 });
      await viewer
        .getByRole('button', { name: 'Restart', exact: true })
        .click();
      await expect(viewer.getByRole('status')).toHaveText(
        'MySTRA viewer is running',
        { timeout: 120000 }
      );
      await expect(
        frame
          .getByRole('heading', { name: 'Viewer integration', exact: true })
          .first()
      ).toBeVisible();
      expect(blocked).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath('mystra-viewer.png')
      });
    } finally {
      // Stop before Galata removes the watched files or shuts down its server.
      const baseUrl = await page.evaluate(
        () => window.jupyterapp.serviceManager.serverSettings.baseUrl
      );
      const endpoint = new URL(
        `${baseUrl}jupyterlab_lightcone/mystra/sessions`,
        server.origin
      );
      const response = await page.request.post(endpoint.href, {
        data: { path: directory }
      });
      if (response.ok()) {
        const session: { id: string } = await response.json();
        await page.request.delete(`${endpoint.href}/${session.id}`);
      }
    }
  });
});
