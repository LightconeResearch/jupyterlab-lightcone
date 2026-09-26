import { expect, test } from '@jupyterlab/galata';

test('renames the project from Home, persists its name and leaves its description intact', async ({
  page,
  tmpPath
}) => {
  const path = `${tmpPath}/astra.yaml`;
  const description =
    'TODO: One-paragraph overview of the analysis — keep this description visible.';
  const source = `# Project notes\nversion: "0.0.14"\nname: Original project\ndescription: ${JSON.stringify(description)}\ninputs: []\noutputs: []\n`;
  await page.contents.uploadContent(source, 'text', path);
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:open-home', {
      cwd
    });
  }, tmpPath);
  const home = page.locator('.jp-jupyterlab-lightcone-HomeView:visible');
  await expect(
    home.getByRole('heading', { name: 'Original project' })
  ).toBeVisible();
  await expect(home).toContainText(description);
  await home.getByRole('button', { name: 'Rename project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveValue('Original project');
  await dialog.getByRole('textbox').fill('Cancelled name');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    home.getByRole('heading', { name: 'Original project' })
  ).toBeVisible();
  await home.getByRole('button', { name: 'Rename project' }).click();
  await dialog.getByRole('textbox').fill('Renamed: project #1');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(
    home.getByRole('heading', { name: 'Renamed: project #1' })
  ).toBeVisible();
  const saved = await page.evaluate(async path => {
    const file = await window.jupyterapp.serviceManager.contents.get(path, {
      format: 'text',
      content: true
    });
    return file.content;
  }, path);
  expect(saved).toContain('name: "Renamed: project #1"');
  expect(saved).toContain('# Project notes');
  expect(saved).toContain(description);
  await page.screenshot({ path: '/tmp/lightcone-project-name.png' });
});
