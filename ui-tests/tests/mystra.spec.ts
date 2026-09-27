import { expect, test } from '@jupyterlab/galata';

const template = process.env.MYSTRA_TEST_TEMPLATE;
const command = 'jupyterlab_lightcone:open-mystra';

test.describe('MySTRA Viewer with the actual CLI and theme', () => {
  test.skip(
    !template,
    'Set MYSTRA_TEST_TEMPLATE to a built ASTRA article or book template.'
  );
  test.setTimeout(180000);

  test('opens, reuses, closes, reopens, navigates, reloads saved content, and restarts', async ({
    page,
    tmpPath
  }) => {
    const directory = `${tmpPath}/publication`;
    await page.contents.createDirectory(directory);
    await page.contents.uploadContent(
      'name: Viewer integration\ninputs: []\noutputs: []\n',
      'text',
      `${directory}/astra.yaml`
    );
    await page.contents.uploadContent(
      `version: 1\nproject:\n  title: Viewer integration\n  toc:\n    - file: index.md\n    - file: methods.md\nsite:\n  template: ${JSON.stringify(template)}\n`,
      'text',
      `${directory}/myst.yml`
    );
    await page.contents.uploadContent(
      '# Viewer integration\n\nInline math: $x^2 + y^2$.\n\n[Methods](methods.md)\n',
      'text',
      `${directory}/index.md`
    );
    await page.contents.uploadContent(
      '# Methods\n\nOriginal methods.\n',
      'text',
      `${directory}/methods.md`
    );
    // Server-rendered headings appear before hydration opens the live channel.
    // Observe the native connection so edits test an interactive viewer.
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes('/mystra/')) return;
          this.addEventListener('open', () => {
            document.documentElement.dataset.mystraLive = 'true';
          });
          this.addEventListener('close', () => {
            delete document.documentElement.dataset.mystraLive;
          });
        }
      };
    });
    const blocked: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const reloadFrames: string[] = [];
    const server = new URL(page.url());
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.port !== server.port
      )
        blocked.push(url.href);
      if (!url.pathname.includes('/mystra/')) return;
      reloadFrames.push('OPEN ' + url.href);
      socket.on('framereceived', frame =>
        reloadFrames.push(String(frame.payload))
      );
      socket.on('close', () => reloadFrames.push('CLOSED'));
      socket.on('socketerror', error => reloadFrames.push('ERROR ' + error));
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        (url.port !== server.port ||
          url.pathname.startsWith('/myst_assets_folder/'))
      ) {
        blocked.push(url.href);
        return route.abort();
      }
      return route.continue();
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
    const viewerLogs = () =>
      page.locator('.jp-jupyterlab-lightcone-MySTRA pre').allTextContents();
    try {
      await open();
      const viewerPanel = page.locator('.jp-jupyterlab-lightcone-MySTRA');
      await expect(viewerPanel).toBeVisible();
      const id = await viewerPanel.getAttribute('id');
      expect(id).toBeTruthy();
      const viewer = page.locator(`[id="${id}"]`);
      await expect(viewer.locator('[role="status"]')).toHaveText(
        'MySTRA viewer is running',
        { timeout: 120000 }
      );
      const frame = viewer.frameLocator('iframe');
      await expect(
        frame
          .getByRole('heading', { name: 'Viewer integration', exact: true })
          .first()
      ).toBeVisible();
      await expect(frame.locator('html')).toHaveAttribute(
        'data-mystra-live',
        'true'
      );
      await page.contents.uploadContent(
        '# Viewer integration\n\nUpdated index from disk.\n\n[Methods](methods.md)\n',
        'text',
        `${directory}/index.md`
      );
      await expect(
        frame.getByText('Updated index from disk.', { exact: true })
      ).toBeVisible({ timeout: 20000 });
      const failedFonts = await frame.locator('body').evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts]
          .filter(font => font.status === 'error')
          .map(font => font.family);
      });
      expect(failedFonts).toEqual([]);
      expect(await open()).toBe(id);
      await page
        .getByRole('tab', { name: /MySTRA/ })
        .locator('.lm-TabBar-tabCloseIcon')
        .click();
      await expect(viewerPanel).toHaveCount(0);
      expect(await open()).toBe(id); // Reuse the warm server process in a new tab.
      await expect(
        frame
          .getByRole('heading', { name: 'Viewer integration', exact: true })
          .first()
      ).toBeVisible();
      await frame
        .locator('a[href$="/methods"]')
        .filter({ visible: true })
        .first()
        .click({ timeout: 10000 });
      await expect(
        frame.getByText('Original methods.', { exact: true })
      ).toBeVisible();
      await expect(frame.locator('html')).toHaveAttribute(
        'data-mystra-live',
        'true'
      );
      await page.contents.uploadContent(
        '# Methods\n\nUpdated methods from disk.\n',
        'text',
        `${directory}/methods.md`
      );
      await expect(
        frame.getByText('Updated methods from disk.', { exact: true })
      ).toBeVisible({ timeout: 20000 });
      await expect(viewer.locator('[role="status"]')).toBeHidden();
      await page.evaluate(() =>
        window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:restart-mystra'
        )
      );
      await expect(viewer.locator('[role="status"]')).toHaveText(
        'MySTRA viewer is running',
        { timeout: 120000 }
      );
      await expect(
        frame
          .getByRole('heading', { name: 'Viewer integration', exact: true })
          .first()
      ).toBeVisible();
      await expect(frame.locator('html')).toHaveAttribute(
        'data-mystra-live',
        'true'
      );
      await page.contents.uploadContent(
        '# Viewer integration\n\nUpdated index after restart.\n',
        'text',
        `${directory}/index.md`
      );
      await expect(
        frame.getByText('Updated index after restart.', { exact: true })
      ).toBeVisible({ timeout: 20000 });
      expect(blocked).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath('mystra-viewer.png')
      });
    } catch (error) {
      await test.info().attach('mystra-diagnostics', {
        contentType: 'application/json',
        body: JSON.stringify({
          reloadFrames,
          errors,
          blocked,
          logs: await viewerLogs()
        })
      });
      throw error;
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
