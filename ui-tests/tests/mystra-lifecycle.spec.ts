import { expect, test } from '@jupyterlab/galata';
import type { IMySTRASession } from '../../src/api';

// Exercise the real Home command, tab close button, tracker and iframe without
// requiring a downloaded theme. The actual CLI/theme has its own integration test.
test('opens, closes, reopens, expires, restarts and recovers a viewer', async ({
  page,
  tmpPath
}) => {
  let active: IMySTRASession | undefined;
  let created = 0;
  let stopped = 0;
  let ready = false;
  let failNext = false;
  await page.route('**/jupyterlab_lightcone/mystra/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/sessions') && request.method() === 'POST') {
      if (!active) {
        const id = (++created).toString(16).padStart(32, '0');
        active = {
          id,
          path: `${tmpPath}/myst.yml`,
          state: failNext ? 'failed' : ready ? 'ready' : 'starting',
          message: failNext ? 'Test CLI failed' : 'Starting MySTRA…',
          logs: [],
          url: `/jupyterlab_lightcone/mystra/${id}/site/`
        };
        failNext = false;
      }
      await route.fulfill({ json: active });
    } else if (path.includes('/sessions/') && request.method() === 'DELETE') {
      active = undefined;
      stopped++;
      await route.fulfill({ status: 204 });
    } else if (path.includes('/sessions/')) {
      if (active) {
        if (ready && active.state === 'starting')
          active = {
            ...active,
            state: 'ready',
            message: 'MySTRA viewer is running'
          };
        await route.fulfill({ json: active });
      } else
        await route.fulfill({
          status: 404,
          json: { message: 'Session expired' }
        });
    } else {
      await route.fulfill({
        contentType: 'text/html',
        body: `<h1>Report ${created}</h1>`
      });
    }
  });
  await page.contents.uploadContent(
    'name: Viewer lifecycle\ninputs: []\noutputs: []\n',
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.contents.uploadContent(
    'version: 1\n',
    'text',
    `${tmpPath}/myst.yml`
  );
  await page.evaluate(
    cwd =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:open-home', {
        cwd
      }),
    tmpPath
  );
  const home = page.locator('.jp-jupyterlab-lightcone-HomeView:visible');
  const viewer = page.locator('.jp-jupyterlab-lightcone-MySTRA');
  const open = () =>
    home.getByRole('button', { name: 'Open report', exact: true }).click();
  const close = async () => {
    await page
      .getByRole('tab', { name: /MySTRA/ })
      .locator('.lm-TabBar-tabCloseIcon')
      .click();
    await expect(viewer).toHaveCount(0);
  };
  const report = (number: number) =>
    viewer
      .frameLocator('iframe')
      .getByRole('heading', { name: `Report ${number}`, exact: true });

  await open();
  await expect(viewer.getByRole('status')).toHaveText('Starting MySTRA…');
  await close();
  expect(stopped).toBe(0);
  ready = true;
  await open();
  await expect(report(1)).toBeVisible();
  expect(created).toBe(1); // Reuse the still-leased server session.
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute(
      'jupyterlab_lightcone:open-mystra',
      {
        path
      }
    );
  }, tmpPath);
  await expect(viewer).toHaveCount(1);
  await close();
  active = undefined; // The server reaped the session while the tab was closed.
  await open();
  await expect(report(2)).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.jupyterapp.commands.isEnabled(
        'jupyterlab_lightcone:restart-mystra'
      )
    )
  ).toBe(true);
  await page.evaluate(() =>
    window.jupyterapp.commands.execute('jupyterlab_lightcone:restart-mystra')
  );
  await expect(report(3)).toBeVisible();
  expect(stopped).toBe(1);
  await close();
  active = undefined;
  failNext = true;
  await open();
  await expect(viewer.getByRole('status')).toHaveText('Test CLI failed');
  await viewer.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(report(5)).toBeVisible();
  await close();
  await open();
  await expect(report(5)).toBeVisible();
  expect(stopped).toBe(2);
  await page.evaluate(() =>
    window.jupyterapp.commands.execute('application:close')
  );
  await expect(viewer).toHaveCount(0);
});
