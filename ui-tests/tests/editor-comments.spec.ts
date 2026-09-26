import { expect, test } from '@jupyterlab/galata';
import type { IComment } from '../../src/comments/comments-api';

test('an editor selection keeps its saved comment after closing and reopening the file', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  const file = `${tmpPath}/analysis.py`;
  const quote = 'beta = alpha + 2';
  const commentsAPI = '/jupyterlab_lightcone/api/comments';
  await page.contents.uploadContent(
    "version: '0.0.14'\nname: Editor comments\ninputs: []\noutputs: []\n",
    'text',
    entrypoint
  );
  await page.contents.uploadContent(
    `alpha = 1\n${quote}\nprint(beta)\n`,
    'text',
    file
  );
  const openFile = () =>
    page.evaluate(async path => {
      await window.jupyterapp.commands.execute('docmanager:open', {
        path,
        factory: 'Editor'
      });
    }, file);
  await openFile();
  const editor = page.locator('.jp-FileEditor:visible');
  const content = editor.locator('.cm-content');
  await expect(content).toContainText(quote);

  // Use native CodeMirror keyboard selection, including its floating action.
  await content.click();
  await content.press('Control+Home');
  await content.press('ArrowDown');
  await content.press('Home');
  await content.press('Shift+End');
  const commentButton = page.getByRole('button', {
    name: 'Comment',
    exact: true
  });
  await expect(commentButton).toBeVisible();
  await commentButton.click();
  const popover = page.getByRole('dialog', { name: 'Comment', exact: true });
  await popover
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Explain why two is added.');
  const created = page.waitForResponse(
    response =>
      response.url().includes(commentsAPI) &&
      response.request().method() === 'POST'
  );
  await popover.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(popover).toBeHidden();

  // Read the real store through its API; no comment or editor routes are mocked.
  const response = await page.request.get(
    `${commentsAPI}?${new URLSearchParams({ path: entrypoint })}`
  );
  expect(response.ok()).toBe(true);
  const { comments }: { comments: IComment[] } = await response.json();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    text: 'Explain why two is added.',
    status: 'pending',
    target: { kind: 'file', path: file, record: null, universe: null },
    anchor: {
      type: 'text',
      startLine: 2,
      startCol: 1,
      endLine: 2,
      endCol: quote.length + 1,
      quote,
      prefix: 'alpha = 1\n'
    }
  });
  const badge = editor.locator('.jp-jupyterlab-lightcone-CommentBadge');
  const highlight = editor.locator('.jp-jupyterlab-lightcone-CommentMark');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('data-comment-id', comments[0].id);
  await expect(highlight).toHaveText(quote);

  // Closing disposes the host and its selection UI. Reopening restores one
  // decoration from the persisted anchor, without duplicate host listeners.
  await page.activity.activateTab('analysis.py');
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute('application:close');
  });
  await expect(editor).toHaveCount(0);
  await expect(commentButton).toHaveCount(0);
  await expect(popover).toHaveCount(0);
  await openFile();
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('data-comment-id', comments[0].id);
  await expect(highlight).toHaveText(quote);
  await expect(commentButton).toHaveCount(0);

  // The restored badge is interactive, and deleting removes its decoration.
  await badge.focus();
  await page.keyboard.press('Enter');
  await expect(popover).toContainText('Explain why two is added.');
  const removed = page.waitForResponse(
    response =>
      response.url().includes(commentsAPI) &&
      response.request().method() === 'DELETE'
  );
  await popover.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await removed).status()).toBe(204);
  await expect(popover).toBeHidden();
  await expect(badge).toHaveCount(0);
  await expect(highlight).toHaveCount(0);
});
