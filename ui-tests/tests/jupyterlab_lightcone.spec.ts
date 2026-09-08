import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Request } from '@playwright/test';

const OPEN_INVENTORY = 'jupyterlab_lightcone:open-inventory';
const REFRESH = 'jupyterlab_lightcone:refresh';
const DOI = '10.1234/continuous-test';
const QUOTE = 'A reproducible result appears on the final page.';

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

test('refreshes unmaterialized outputs without requesting missing result directories', async ({
  page,
  tmpPath
}) => {
  const path = `${tmpPath}/astra.yaml`;
  await page.contents.uploadContent(analysis('Pending results'), 'text', path);
  const directories: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (
      url.pathname.includes(`/api/contents/${tmpPath}/results`) &&
      url.searchParams.get('type') === 'directory'
    ) {
      directories.push(url.pathname);
    }
  });
  await openInventory(page, path, { kind: 'output', id: 'sample' });
  for (let refresh = 0; refresh < 2; refresh++) {
    await page.evaluate(
      command => window.jupyterapp.commands.execute(command),
      REFRESH
    );
  }
  expect(directories).toEqual([]);

  await page.contents.createDirectory(`${tmpPath}/results/default`);
  await page.contents.uploadContent(
    'id,value\ncreated,42\n',
    'text',
    `${tmpPath}/results/default/sample.csv`
  );
  await page.evaluate(
    command => window.jupyterapp.commands.execute(command),
    REFRESH
  );
  await expect(
    page.getByRole('dialog').getByRole('cell', { name: 'created', exact: true })
  ).toBeVisible();
  expect(directories).toContain(`/api/contents/${tmpPath}/results/default`);
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

test('an explicit scope changes the analysis in a reused inventory document', async ({
  page,
  tmpPath
}) => {
  const directory = `${tmpPath}/project`;
  await createProject(page, `${directory}/child`, 'Child analysis');
  const path = `${directory}/astra.yaml`;
  await page.contents.uploadContent(
    `${analysis('Parent analysis')}analyses:\n  child:\n    path: child\n`,
    'text',
    path
  );
  const id = await openInventory(page, path);
  const selector = page.locator(
    '.jp-jupyterlab-lightcone-analysis-selector select'
  );
  for (const scope of ['child', 'root']) {
    await page.evaluate(
      async ({ path, scope }) => {
        await window.jupyterapp.commands.execute(
          'jupyterlab_lightcone:open-inventory',
          { path, scope }
        );
      },
      { path, scope }
    );
    await expect(selector).toHaveValue(scope === 'root' ? '$' : scope);
    expect(await openInventory(page, path)).toBe(id);
    await expect(selector).toHaveValue(scope === 'root' ? '$' : scope);
  }
});

for (const edit of ['remove', 'rename']) {
  test(`recovers the analysis selection and closes obsolete details after ${edit}`, async ({
    page,
    tmpPath
  }) => {
    const directory = `${tmpPath}/project`;
    await createProject(page, `${directory}/child`, 'Child analysis');
    const path = `${directory}/astra.yaml`;
    await page.contents.uploadContent(
      `${analysis('Parent analysis')}analyses:\n  child:\n    path: child\n`,
      'text',
      path
    );
    const id = await openInventory(page, path);
    await page.evaluate(async path => {
      await window.jupyterapp.commands.execute(
        'jupyterlab_lightcone:open-inventory',
        {
          path,
          analysisPath: 'child',
          openReference: { kind: 'output', id: 'sample' }
        }
      );
    }, path);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.contents.uploadContent(
      analysis('Parent analysis') +
        (edit === 'rename' ? 'analyses:\n  renamed:\n    path: child\n' : ''),
      'text',
      path
    );
    await page.evaluate(
      command => window.jupyterapp.commands.execute(command),
      REFRESH
    );
    const selector = page.locator(
      '.jp-jupyterlab-lightcone-analysis-selector select'
    );
    await expect(selector).toHaveValue('$');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await openInventory(page, path)).toBe(id);
    await expect(selector).toHaveValue('$');
    if (edit === 'rename') {
      await selector.selectOption('renamed');
      await expect(
        page.getByRole('heading', { name: 'Child analysis', exact: true })
      ).toBeVisible();
    }
  });
}

for (const complete of [true, false]) {
  test(`PDF navigation ${complete ? 'prefers a later complete quote' : 'falls back to the first partial quote'}`, async ({
    page,
    tmpPath
  }) => {
    const path = `${tmpPath}/astra.yaml`;
    await page.contents.uploadContent(
      analysis('Quote search')
        .replace('        location:\n          page: 3\n', '')
        .replace(QUOTE, complete ? QUOTE : `${QUOTE} An absent continuation.`),
      'text',
      path
    );
    await openInventory(page, path, { kind: 'paper', doi: DOI });
    await page
      .getByRole('button', { name: 'Locate source passage 1 in paper' })
      .click();
    const pdf = page.getByRole('group', {
      name: 'PDF viewer for Continuous scrolling test paper',
      exact: true
    });
    const pageNumber = complete ? 3 : 1;
    await expect(pdf.getByRole('status')).toHaveText(
      `${complete ? 'Quote' : 'Partial quote'} highlighted on page ${pageNumber} of 3`
    );
    const highlight = pdf
      .getByRole('group', { name: `Page ${pageNumber}`, exact: true })
      .locator('mark');
    await expect(highlight).toHaveText(
      complete ? QUOTE : 'A reproducible result appears'
    );
    // Allow subpixel rounding in the browser's intersection ratio.
    await expect(highlight).toBeInViewport({ ratio: 0.99 });
  });
}

test('reads cached PDF pages and preserves quote navigation when zooming', async ({
  page,
  tmpPath
}) => {
  const path = await createProject(page, `${tmpPath}/project`, 'Paper project');
  await openInventory(page, path, { kind: 'paper', doi: DOI });
  const pdf = page.getByRole('group', {
    name: 'PDF viewer for Continuous scrolling test paper',
    exact: true
  });
  const pages = pdf.getByRole('region', { name: 'PDF pages', exact: true });
  await expect(pages.getByRole('group', { name: /^Page \d+$/ })).toHaveCount(3);
  await page
    .getByRole('button', { name: 'Locate source passage 1 in paper' })
    .click();
  const lastPage = pages.getByRole('group', { name: 'Page 3', exact: true });
  const highlight = lastPage.locator('mark');
  await expect(highlight).toHaveText(QUOTE);
  await expect(highlight).toBeInViewport({
    ratio: 0.99
  });
  const canvas = lastPage.locator('canvas');
  const width = await canvas.evaluate(element =>
    element instanceof HTMLCanvasElement ? element.width : 0
  );
  await pdf.getByRole('button', { name: 'Zoom PDF in' }).click();
  await expect
    .poll(() =>
      canvas.evaluate(element =>
        element instanceof HTMLCanvasElement ? element.width : 0
      )
    )
    .toBeGreaterThan(width);
  await expect(highlight).toHaveText(QUOTE);
  await expect(highlight).toBeInViewport({
    ratio: 0.99
  });
  await page.getByRole('button', { name: 'Close paper details' }).click();

  await expect(pdf).toHaveCount(0);
});

test('renders the shared components in the Lightcone brand, free of JupyterLab element styles', async ({
  page,
  tmpPath
}) => {
  const path = await createProject(
    page,
    `${tmpPath}/project`,
    'Branded project'
  );
  await openInventory(page, path, { kind: 'output', id: 'sample' });
  await expect(page.getByRole('dialog')).toBeVisible();
  const styles = await page.evaluate(() => {
    const read = (selector: string, properties: string[]) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`No element matches ${selector}.`);
      const computed = getComputedStyle(element);
      return Object.fromEntries(
        properties.map(property => [
          property,
          computed.getPropertyValue(property).trim()
        ])
      );
    };
    return {
      panel: read('.jp-jupyterlab-lightcone-InventoryPanel', [
        'font-size',
        'color',
        '--astra-font-mono',
        '--jp-code-font-family'
      ]),
      card: read('.astra-output-card', ['border-radius']),
      cardTitle: read('.astra-output-card__body strong', ['font-family']),
      outlineLink: read('.astra-inventory-outline a', [
        'color',
        'text-decoration-line'
      ]),
      selector: read('.jp-jupyterlab-lightcone-analysis-selector select', [
        'font-family',
        'border-radius'
      ]),
      action: read('dialog[open] .astra-dialog__action', [
        'border-radius',
        'font-family'
      ]),
      close: read('dialog[open] .astra-dialog__actions > .astra-icon-button', [
        'border-radius',
        'font-family'
      ])
    };
  });
  // astra-ui's md step, not JupyterLab's --jp-ui-font-size1.
  expect(styles.panel['font-size']).toBe('15px');
  // The brand's mono stack, not JupyterLab's code font.
  expect(styles.panel['--astra-font-mono']).toContain(
    'Lightcone Brand JetBrains Mono'
  );
  expect(styles.panel['--astra-font-mono']).not.toBe(
    styles.panel['--jp-code-font-family']
  );
  for (const family of [
    styles.cardTitle['font-family'],
    styles.selector['font-family'],
    styles.action['font-family'],
    styles.close['font-family']
  ]) {
    expect(family).toContain('Lightcone Brand Alegreya');
  }
  // `.jp-ThemedContainer button` would round every button to 2px.
  expect(styles.card['border-radius']).toBe('0px');
  expect(styles.selector['border-radius']).toBe('0px');
  expect(styles.action['border-radius']).toBe('6px');
  expect(styles.close['border-radius']).toBe('6px');
  // `.jp-ThemedContainer a` would unset the outline's subtle link colour.
  expect(styles.outlineLink['text-decoration-line']).toBe('none');
  expect(styles.outlineLink.color).not.toBe(styles.panel.color);
});
