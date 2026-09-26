import { expect, test } from '@jupyterlab/galata';
import fs from 'node:fs';
import path from 'node:path';

test('chooses an agent on Home before any chat exists and delivers the first message', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'version: "0.0.14"\nname: Agent choice\ninputs: []\noutputs: []\n',
    'text',
    `${tmpPath}/astra.yaml`
  );
  for (const filename of ['lightcone_persona.py', 'second_persona.py']) {
    await page.contents.uploadContent(
      fs.readFileSync(
        path.resolve(__dirname, '../fixtures/personas', filename),
        'utf8'
      ),
      'text',
      `${tmpPath}/.jupyter/personas/${filename}`
    );
  }
  await page.evaluate(async cwd => {
    await window.jupyterapp.commands.execute('jupyterlab_lightcone:open-home', {
      cwd
    });
  }, tmpPath);
  const home = page.locator('.jp-jupyterlab-lightcone-HomeView:visible');
  const picker = home.getByRole('button', { name: /^Agent:/ });
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(
    page.getByRole('menuitem', { name: 'Lightcone test agent', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Second test agent', exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('launcher-agent-menu.png')
  });
  await page.keyboard.press('Escape');
  await expect(picker).toBeFocused();
  // Discovery has not created any chat file or folder.
  expect(await page.contents.directoryExists(`${tmpPath}/chats`)).toBe(false);
  await picker.press('Enter');
  await page
    .getByRole('menuitem', { name: 'Second test agent', exact: true })
    .click();
  await expect(picker).toHaveText('Second test agent');
  await expect
    .poll(() =>
      picker
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth)
    )
    .toBeGreaterThan(0);
  await home.getByRole('textbox').fill('Compare the options.');
  await page.screenshot({
    path: test.info().outputPath('launcher-agent-picker.png')
  });
  await home.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page
      .locator('.jp-chat-rendered-message')
      .filter({ hasText: 'Second test agent received: Compare the options.' })
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(
      '#jp-main-dock-panel .jp-chat-input-container .jp-jai-personaControls-persona-btn'
    )
  ).toHaveText('Second test agent');
  const stored = await page.evaluate(async folder => {
    const file = await window.jupyterapp.serviceManager.contents.get(
      `${folder}/chats/compare-the-options.chat`,
      { format: 'text', content: true }
    );
    return JSON.parse(file.content as string);
  }, tmpPath);
  expect(
    stored.messages.filter(
      (message: { body: string }) => message.body === 'Compare the options.'
    )
  ).toHaveLength(1);
});
