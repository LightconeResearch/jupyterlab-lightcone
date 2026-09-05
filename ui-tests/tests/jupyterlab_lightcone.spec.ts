import { expect, test } from '@jupyterlab/galata';

const viewer = '.jp-jupyterlab-lightcone-Document';
const validProject =
  'version: "0.0.14"\nname: Smoke analysis\ninputs: []\noutputs: []\n';

test.use({ autoGoto: false });

test('opens only astra.yaml with Lightcone, validates projects, and stays read-only', async ({
  page,
  tmpPath
}) => {
  const errors: string[] = [];
  const demoRequests: string[] = [];
  const writes: string[] = [];
  const kernels: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/jupyterlab[-_]lightcone\/hello/.test(request.url())) {
      demoRequests.push(request.url());
    }
    // JupyterLab's shared text context may create its initial checkpoint.
    if (
      request.method() !== 'GET' &&
      /\/api\/contents\//.test(request.url()) &&
      !(
        request.method() === 'POST' &&
        /\/checkpoints(?:\?|$)/.test(request.url())
      )
    ) {
      writes.push(request.url());
    }
    if (
      request.method() === 'POST' &&
      /\/api\/(kernels|sessions)/.test(request.url())
    ) {
      kernels.push(request.url());
    }
  });
  await page.goto();
  await page.contents.uploadContent(
    validProject,
    'text',
    `${tmpPath}/astra.yaml`
  );
  await page.contents.uploadContent(
    'key: value',
    'text',
    `${tmpPath}/other.yaml`
  );
  await page.filebrowser.openDirectory(tmpPath);
  await page
    .getByRole('listitem', { name: /^Name: other\.yaml / })
    .click({ button: 'right' });
  await page.getByText('Open With', { exact: true }).hover();
  await expect(
    page.getByRole('menuitem', { name: 'Editor', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Lightcone Viewer', exact: true })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page
    .getByRole('listitem', { name: /^Name: astra\.yaml / })
    .click({ button: 'right' });
  await page.getByText('Open With', { exact: true }).hover();
  await page
    .getByRole('menuitem', { name: 'Lightcone Viewer', exact: true })
    .click();
  await expect(page.locator(viewer)).toContainText('Valid ASTRA project');
  await expect(page.locator(viewer)).toContainText('Smoke analysis');
  await expect(page.locator(viewer)).toContainText('Analyses: 1');
  expect(writes).toEqual([]);
  expect(kernels).toEqual([]);
  expect(demoRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.activity.closeAll();
  await page
    .getByRole('listitem', { name: /^Name: astra\.yaml / })
    .click({ button: 'right' });
  await page.getByText('Open With', { exact: true }).hover();
  await page
    .getByRole('menuitem', { name: 'Lightcone Viewer', exact: true })
    .click();
  await expect(page.locator(viewer)).toContainText('Valid ASTRA project');
});

test('opens a root project and reports SDK validation locations for a nested project', async ({
  page,
  tmpPath
}) => {
  await page.goto();
  // The test server has an isolated root; clean up this root fixture explicitly.
  await page.contents.uploadContent(validProject, 'text', 'astra.yaml');
  try {
    await page.evaluate(async () => {
      await window.jupyterapp.commands.execute('docmanager:open', {
        path: 'astra.yaml',
        factory: 'Lightcone Viewer'
      });
    });
    await expect(page.locator(viewer)).toContainText('Valid ASTRA project');
    await page.activity.closeAll();
  } finally {
    await page.contents.deleteFile('astra.yaml');
  }
  await page.contents.uploadContent(
    'version: "0.0.14"\nname: 42\n',
    'text',
    `${tmpPath}/nested/astra.yaml`
  );
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute('docmanager:open', {
      path,
      factory: 'Lightcone Viewer'
    });
  }, `${tmpPath}/nested/astra.yaml`);
  await expect(page.locator(viewer)).toContainText('Could not open');
  await expect(page.locator(viewer)).toContainText('astra.yaml');
  await expect(page.locator(viewer)).toContainText('name');
});

test('updates after a project folder rename', async ({ page, tmpPath }) => {
  await page.goto();
  await page.contents.uploadContent(
    validProject,
    'text',
    `${tmpPath}/before/astra.yaml`
  );
  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute('docmanager:open', {
      path,
      factory: 'Lightcone Viewer'
    });
  }, `${tmpPath}/before/astra.yaml`);
  await expect(page.locator(viewer)).toContainText(
    `${tmpPath}/before/astra.yaml`
  );
  // Use the running application's manager so the document context receives fileChanged.
  await page.evaluate(async root => {
    await window.jupyterapp.serviceManager.contents.rename(
      `${root}/before`,
      `${root}/after`
    );
  }, tmpPath);
  await expect(page.locator(viewer)).toContainText(
    `${tmpPath}/after/astra.yaml`
  );
  await expect(page.locator(viewer)).toContainText('Valid ASTRA project');
});
