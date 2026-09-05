import { expect, test } from '@jupyterlab/galata';

test.use({ autoGoto: false });

test('loads and activates the installed extension without startup errors', async ({
  page
}) => {
  const errors: string[] = [];
  const apiRequests: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/(jupyterlab-lightcone|jupyterlab_lightcone)\//.test(path)) {
      apiRequests.push(path);
    }
  });

  await page.goto();

  expect(
    await page.evaluate(async () => {
      const app = window.jupyterapp;
      await app.started;
      await app.restored;
      return app.isPluginActivated('jupyterlab_lightcone:plugin');
    })
  ).toBe(true);
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});
