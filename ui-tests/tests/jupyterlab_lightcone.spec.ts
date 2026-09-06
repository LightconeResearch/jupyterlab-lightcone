import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Request } from '@playwright/test';

const OPEN_INVENTORY = 'jupyterlab_lightcone:open-inventory';
const OPEN_PAPER = 'jupyterlab_lightcone:open-paper';
const REFRESH = 'jupyterlab_lightcone:refresh';
const DOI = '10.1234/continuous-test';
const QUOTE = 'A reproducible result appears on the final page.';
const PUBLICATION = 'https://lightcone-publication.test/article';

/** A self-contained ASTRA project with a materialized table and cited paper. */
function analysis(name: string): string {
  return `version: "0.0.14"
name: ${name}
inputs: []
outputs:
  - id: sample
    type: table
    format: csv
prior_insights:
  precedent:
    claim: A cited result can be inspected.
    created_at: "2026-01-01T00:00:00Z"
    evidence:
      - id: source
        doi: ${DOI}
        quote:
          exact: ${QUOTE}
        location:
          page: 3
`;
}

/** Create files through Contents so the suite also exercises Jupyter file access. */
async function createProject(
  page: IJupyterLabPageFixture,
  directory: string,
  name: string
): Promise<string> {
  await page.contents.createDirectory(`${directory}/results/default`);
  await page.contents.uploadContent(
    analysis(name),
    'text',
    `${directory}/astra.yaml`
  );
  await page.contents.uploadContent(
    'id,value\n' +
      Array.from({ length: 20000 }, (_, index) => `${index},${index}\n`).join(
        ''
      ),
    'text',
    `${directory}/results/default/sample.csv`
  );
  return `${directory}/astra.yaml`;
}

/** Open through the public command and return the active native document ID. */
async function openInventory(
  page: IJupyterLabPageFixture,
  path: string,
  openReference?:
    { kind: 'output'; id: string } | { kind: 'paper'; doi: string }
): Promise<string> {
  return page.evaluate(
    async ({ command, path, openReference }) => {
      const app = window.jupyterapp;
      await app.commands.execute(command, {
        path,
        ...(openReference ? { openReference } : {})
      });
      return app.shell.currentWidget?.id ?? '';
    },
    { command: OPEN_INVENTORY, path, openReference }
  );
}

let runtimeErrors: string[];
test.use({ autoGoto: false });

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto();
});

test.afterEach(() => {
  expect(runtimeErrors, 'No browser runtime errors').toEqual([]);
});

test('viewing a project preserves source files, starts no kernels, and keeps the text editor writable', async ({
  page,
  tmpPath
}) => {
  const path = await createProject(
    page,
    `${tmpPath}/project`,
    'Read-only inventory'
  );
  const files = [path, `${tmpPath}/project/results/default/sample.csv`];
  const readFiles = async (paths: string[]): Promise<string[]> => {
    return Promise.all(
      paths.map(async path => {
        const model = await window.jupyterapp.serviceManager.contents.get(
          path,
          { content: true, format: 'text' }
        );
        if (typeof model.content !== 'string')
          throw new Error('Expected a text fixture.');
        return model.content;
      })
    );
  };
  const original = await page.evaluate(readFiles, files);
  const writes: string[] = [];
  const starts: string[] = [];
  const observe = (request: Request): void => {
    const url = new URL(request.url()).pathname;
    if (
      url.includes('/api/contents/') &&
      ['POST', 'PUT'].includes(request.method()) &&
      // Native text document contexts may create an initial Jupyter checkpoint.
      !(request.method() === 'POST' && url.endsWith('/checkpoints'))
    ) {
      writes.push(`${request.method()} ${url}`);
    }
    if (
      request.method() === 'POST' &&
      /\/api\/(kernels|sessions)\/?$/.test(url)
    ) {
      starts.push(url);
    }
  };
  page.on('request', observe);
  await openInventory(page, path);
  await expect(
    page.getByRole('heading', { name: 'Read-only inventory', exact: true })
  ).toBeVisible();
  expect(await page.evaluate(readFiles, files)).toEqual(original);
  expect(writes, 'Opening the viewer must not modify project files').toEqual(
    []
  );
  expect(
    starts,
    'Opening the viewer must not start kernels or sessions'
  ).toEqual([]);
  page.off('request', observe);

  await page.evaluate(async path => {
    await window.jupyterapp.commands.execute('docmanager:open', {
      path,
      factory: 'Editor'
    });
  }, path);
  const editor = page.locator('.jp-FileEditor .cm-content');
  await expect(editor).toBeEditable();
  const updated = analysis('Edited in the text editor');
  await editor.fill(updated);
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute('docmanager:save');
  });
  expect(
    await page.evaluate(async path => {
      const file = await window.jupyterapp.serviceManager.contents.get(path, {
        content: true
      });
      return file.content;
    }, path)
  ).toBe(updated);
  await openInventory(page, path);
  await expect(
    page.getByRole('heading', {
      name: 'Edited in the text editor',
      exact: true
    })
  ).toBeVisible();
});

test('opens native documents, reuses each project, and follows the Jupyter theme', async ({
  page,
  tmpPath
}) => {
  const first = await createProject(page, `${tmpPath}/first`, 'First project');
  const second = await createProject(
    page,
    `${tmpPath}/second`,
    'Second project'
  );

  // Jupyter's ordinary document command must choose the registered viewer.
  const firstId = await page.evaluate(async path => {
    await window.jupyterapp.commands.execute('docmanager:open', { path });
    return window.jupyterapp.shell.currentWidget?.id ?? '';
  }, first);
  await expect(
    page.getByRole('heading', { name: 'First project', exact: true })
  ).toBeVisible();
  expect(await openInventory(page, first)).toBe(firstId);

  const secondId = await openInventory(page, second);
  expect(secondId).not.toBe(firstId);
  await expect(
    page.getByRole('heading', { name: 'Second project', exact: true })
  ).toBeVisible();
  expect(await openInventory(page, first)).toBe(firstId);
  await expect(
    page.getByRole('heading', { name: 'First project', exact: true })
  ).toBeVisible();
  await expect(page.locator('.jp-jupyterlab-lightcone-Document')).toHaveCount(
    2
  );

  await page.theme.setDarkTheme();
  await expect(page.locator(`#${firstId} .astra-ui`).first()).toHaveAttribute(
    'data-lightcone-color-scheme',
    'dark'
  );
  await page.theme.setLightTheme();
  await expect(page.locator(`#${firstId} .astra-ui`).first()).toHaveAttribute(
    'data-lightcone-color-scheme',
    'light'
  );
});

test('retains valid project data after malformed edits and recovers without reopening details', async ({
  page,
  tmpPath
}) => {
  const path = await createProject(
    page,
    `${tmpPath}/project`,
    'Recoverable project'
  );
  const id = await openInventory(page, path, { kind: 'output', id: 'sample' });
  await page.getByRole('button', { name: 'Close output details' }).click();
  await page.contents.uploadContent('version: [', 'text', path);
  const warning = page.getByText(/Showing the last valid project data/);
  await expect(warning).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole('heading', { name: 'Recoverable project', exact: true })
  ).toBeVisible();
  expect(await openInventory(page, path)).toBe(id);
  await expect(warning).toBeVisible();
  await page.contents.uploadContent(
    analysis('Recovered project'),
    'text',
    path
  );
  await expect(
    page.getByRole('heading', { name: 'Recovered project', exact: true })
  ).toBeVisible({ timeout: 20000 });
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('samples large CSV artifacts and refreshes previews after the artifact changes', async ({
  page,
  tmpPath
}) => {
  const directory = `${tmpPath}/project`;
  const path = await createProject(page, directory, 'Artifact project');
  const requests: { url: string; range: string | undefined }[] = [];
  page.on('request', request => {
    if (
      request.url().includes('/files/') &&
      request.url().includes('sample.csv')
    ) {
      requests.push({ url: request.url(), range: request.headers().range });
    }
  });
  await openInventory(page, path, { kind: 'output', id: 'sample' });
  await expect(page.getByText(/total unknown/)).toBeVisible();
  expect(requests.some(request => request.range === 'bytes=0-65535')).toBe(
    true
  );
  const originalUrl = requests.at(-1)?.url;
  await page.contents.uploadContent(
    'id,value\nchanged,42\n',
    'text',
    `${directory}/results/default/sample.csv`
  );
  await page.evaluate(
    command => window.jupyterapp.commands.execute(command),
    REFRESH
  );
  await expect(
    page.getByRole('dialog').getByRole('cell', { name: 'changed', exact: true })
  ).toBeVisible();
  await expect(page.getByText(/total unknown/)).toHaveCount(0);
  expect(requests.at(-1)?.url).not.toBe(originalUrl);
});

test('reads cached PDF pages and quotes, and accepts references only from its MyST frame', async ({
  page,
  tmpPath
}) => {
  const path = await createProject(page, `${tmpPath}/project`, 'Paper project');
  await openInventory(page, path, { kind: 'paper', doi: DOI });
  const pdf = page.locator('.jp-jupyterlab-lightcone-pdf');
  await expect(pdf.locator('[data-page]')).toHaveCount(3);
  await page
    .getByRole('button', { name: 'Locate source passage 1 in paper' })
    .click();
  await expect(pdf.locator('[data-page="3"] mark')).toHaveText(QUOTE);
  await expect(pdf.locator('[data-page="3"] mark')).toBeInViewport({
    ratio: 1
  });
  const canvas = pdf.locator('[data-page="3"] canvas');
  const width = await canvas.evaluate(element =>
    element instanceof HTMLCanvasElement ? element.width : 0
  );
  await page.getByRole('button', { name: 'Zoom PDF in' }).click();
  await expect
    .poll(() =>
      canvas.evaluate(element =>
        element instanceof HTMLCanvasElement ? element.width : 0
      )
    )
    .toBeGreaterThan(width);
  await expect(pdf.locator('[data-page="3"] mark')).toHaveText(QUOTE);
  await expect(pdf.locator('[data-page="3"] mark')).toBeInViewport({
    ratio: 1
  });
  await page.getByRole('button', { name: 'Close paper details' }).click();

  // Explicit publication context must win over an unrelated active inventory.
  const otherPath = await createProject(
    page,
    `${tmpPath}/other`,
    'Unrelated project'
  );
  await page.contents.uploadContent(
    analysis('Unrelated project').replace(DOI, '10.1234/unrelated'),
    'text',
    otherPath
  );
  await openInventory(page, otherPath);

  await page.route(PUBLICATION, route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Local test publication</title><h1>MyST fixture</h1>'
    })
  );
  const paperId = await page.evaluate(
    async ({ command, path, url }) => {
      await window.jupyterapp.commands.execute(command, { path, url });
      return window.jupyterapp.shell.currentWidget?.id ?? '';
    },
    { command: OPEN_PAPER, path, url: PUBLICATION }
  );
  const panel = page.locator(`#${paperId}`);
  await expect(panel.locator('iframe')).toHaveAttribute('src', PUBLICATION);
  await expect(
    panel.frameLocator('iframe').getByRole('heading', { name: 'MyST fixture' })
  ).toBeVisible();
  const frame = page.frames().find(frame => frame.url() === PUBLICATION);
  expect(frame).toBeDefined();
  if (!frame) throw new Error('The publication frame did not load.');
  await expect(
    frame.getByRole('heading', { name: 'MyST fixture' })
  ).toBeVisible();
  const message = {
    type: 'astra:open-reference',
    reference: { kind: 'paper', doi: DOI }
  };

  // A matching payload from the parent window is not from the trusted frame.
  await page.evaluate(
    data => window.postMessage(data, window.location.origin),
    message
  );
  await frame.evaluate(() =>
    parent.postMessage(
      { type: 'astra:open-reference', reference: { kind: 'paper', doi: 3 } },
      '*'
    )
  );
  await expect(panel.getByRole('dialog')).toHaveCount(0);
  // An untrusted origin is rejected even if the source and payload match.
  await page.evaluate(data => {
    const source = document.querySelector<HTMLIFrameElement>(
      'iframe[title="MyST publication"]'
    )?.contentWindow;
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: 'https://untrusted.test',
        source
      })
    );
  }, message);
  await expect(panel.getByRole('dialog')).toHaveCount(0);

  await frame.evaluate(data => parent.postMessage(data, '*'), message);
  await expect(
    panel.locator('.jp-jupyterlab-lightcone-pdf [data-page]')
  ).toHaveCount(3);
  await expect(
    panel.getByRole('heading', { name: 'Paper project', exact: true })
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close paper details' }).click();
  // Reopening the same publication/project pair reuses its panel.
  const repeatedId = await page.evaluate(
    async ({ command, path, url }) => {
      await window.jupyterapp.commands.execute(command, { path, url });
      return window.jupyterapp.shell.currentWidget?.id ?? '';
    },
    { command: OPEN_PAPER, path, url: PUBLICATION }
  );
  expect(repeatedId).toBe(paperId);
  await expect(panel.getByRole('dialog')).toHaveCount(0);
});
