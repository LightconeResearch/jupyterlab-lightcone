import { expect, test } from '@jupyterlab/galata';
import { parse } from 'yaml';

test('renders Markdown while adding, editing, cancelling and clearing a description', async ({
  page,
  tmpPath
}) => {
  const path = `${tmpPath}/astra.yaml`;
  const source =
    '# Project notes\nversion: "0.0.14"\nname: Description study\ninputs: []\noutputs: []\n';
  await page.contents.uploadContent(source, 'text', path);
  await page.contents.uploadContent(
    'Project notes',
    'text',
    `${tmpPath}/notes.txt`
  );
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:open-home', {
      cwd
    });
  }, tmpPath);
  const home = page.locator('.jp-jupyterlab-lightcone-HomeView:visible');
  await home.getByRole('button', { name: 'Add description' }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('textbox', {
    name: 'Description',
    exact: true
  });
  await expect(input).toBeFocused();
  await input.fill('Question: does **A > B**?');
  await input.press('End');
  await input.press('Enter');
  await input.press('Enter');
  await input.pressSequentially('Findings: "yes" # preliminary');
  await input.press('Enter');
  await input.press('Enter');
  await input.pressSequentially('- Compare `A` and *B*');
  await input.press('Enter');
  await input.pressSequentially('- Read [notes](notes.txt)');
  const description =
    'Question: does **A > B**?\n\nFindings: "yes" # preliminary\n\n- Compare `A` and *B*\n- Read [notes](notes.txt)';
  await expect(input).toHaveValue(description);
  await page.screenshot({ path: '/tmp/lightcone-description-dialog.png' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const rendered = home.locator(
    '.jp-jupyterlab-lightcone-Home-descriptionMarkdown'
  );
  await expect(rendered.locator('p')).toHaveText([
    'Question: does A > B?',
    'Findings: "yes" # preliminary'
  ]);
  await expect(rendered.locator('strong')).toHaveText('A > B');
  await expect(rendered.locator('li')).toHaveText([
    'Compare A and B',
    'Read notes'
  ]);
  await expect(rendered.locator('code')).toHaveText('A');
  await expect(rendered.locator('em')).toHaveText('B');
  await expect
    .poll(() =>
      rendered
        .getByRole('link', { name: 'notes' })
        .evaluate((anchor: HTMLAnchorElement) => new URL(anchor.href).pathname)
    )
    .toBe(`/files/${tmpPath}/notes.txt`);
  const readSource = () =>
    page.evaluate(async path => {
      const file = await window.jupyterapp.serviceManager.contents.get(path, {
        format: 'text',
        content: true
      });
      return file.content as string;
    }, path);
  const saved = await readSource();
  expect(saved).toContain('# Project notes');
  expect(saved).toContain('name: Description study');
  expect(parse(saved).description).toBe(description);
  expect(saved).toContain('Findings: "yes" # preliminary');
  await page.screenshot({ path: '/tmp/lightcone-description-home.png' });
  await home.getByRole('button', { name: 'Edit description' }).click();
  await expect(input).toHaveValue(description);
  await input.fill('Cancelled edit');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readSource()).toBe(saved);
  await home.getByRole('button', { name: 'Edit description' }).click();
  await input.fill('Revised description');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    home.locator('.jp-jupyterlab-lightcone-Home-description')
  ).toContainText('Revised description');
  await home.getByRole('button', { name: 'Edit description' }).click();
  await expect(input).toHaveValue('Revised description');
  await input.fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    home.getByRole('button', { name: 'Add description' })
  ).toBeVisible();
  expect(parse(await readSource()).description).toBe('');
});
