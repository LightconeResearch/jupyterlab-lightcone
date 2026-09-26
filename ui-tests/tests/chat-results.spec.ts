import type { IChatPanel } from '@jupyter/chat';
import { expect, test } from '@jupyterlab/galata';
import fs from 'node:fs';
import path from 'node:path';

test('a reply result previews and opens its recorded commit beside the session', async ({
  page,
  tmpPath
}) => {
  const entrypoint = `${tmpPath}/astra.yaml`;
  const recorded = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const image = (color: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="${color}"/></svg>`;
  await page.contents.uploadContent(
    fs.readFileSync(
      path.resolve(__dirname, '../fixtures/personas/lightcone_persona.py'),
      'utf8'
    ),
    'text',
    `${tmpPath}/.jupyter/personas/lightcone_persona.py`
  );
  await page.contents.uploadContent(
    `version: '0.0.14'
name: Reply results
inputs: []
outputs:
  - id: figure
    label: Recorded figure
    type: figure
    format: svg
`,
    'text',
    entrypoint
  );
  await page.contents.uploadContent(
    image('blue'),
    'text',
    `${tmpPath}/results/default/figure.svg`
  );

  // The native persona echoes a reply. Only repository history is mocked;
  // its timestamp comes from the real server-stamped reply, avoiding clock skew.
  await page.route(
    '**/jupyterlab_lightcone/api/versions/results?*',
    async route => {
      const time = await page.evaluate(() => {
        const panel = Array.from(window.jupyterapp.shell.widgets('main')).find(
          widget => widget.node.querySelector('.jp-chat-input-container')
        ) as IChatPanel | undefined;
        const replies = panel?.model.messages.filter(message =>
          message.sender.username.startsWith('jupyter-ai-personas::')
        );
        const reply = replies?.[replies.length - 1];
        if (!reply)
          throw new Error('The results footer needs a real agent reply.');
        return reply.time;
      });
      await route.fulfill({
        json: {
          commits: [
            {
              commit: recorded,
              short: recorded.slice(0, 7),
              time: new Date(time * 1000).toISOString(),
              subject: 'Update figure during this reply',
              outputs: [{ universe: 'default', output: 'figure' }]
            }
          ]
        }
      });
    }
  );
  await page.route('**/jupyterlab_lightcone/api/versions?*', route =>
    route.fulfill({
      json: {
        file: 'results/default/figure.svg',
        annex: 'none',
        versions: [newer, recorded].map(commit => ({
          commit,
          short: commit.slice(0, 7),
          file: 'results/default/figure.svg',
          time: '2026-09-20T10:00:00Z',
          subject: 'Update figure',
          size: image('green').length,
          present: true,
          annex: null,
          manifest: null
        }))
      }
    })
  );
  await page.route('**/jupyterlab_lightcone/api/versions/content?*', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: image(
        new URL(route.request().url()).searchParams.get('commit') === recorded
          ? 'green'
          : 'blue'
      )
    })
  );

  await page.evaluate(
    args =>
      window.jupyterapp.commands.execute('jupyterlab_lightcone:discuss', args),
    { entrypoint }
  );
  const composer = page
    .locator('.jp-chat-input-container')
    .getByRole('combobox');
  await expect(composer).toBeVisible();
  // This fixture branch only echoes; it invokes no model, MCP tool or recipe.
  await composer.fill('Compare the options. Show the recorded result.');
  await page.locator('.jp-chat-send-button').click();
  await expect(
    page
      .locator('.jp-chat-rendered-message')
      .filter({ hasText: 'Agent received:' })
  ).toBeVisible({ timeout: 30000 });

  const footer = page.locator('.jp-jupyterlab-lightcone-TurnResults');
  await expect(footer).toContainText('Results updated during this reply · 1');
  const tile = footer.locator('.jp-jupyterlab-lightcone-TurnResults-tile');
  await expect(tile).toContainText('Recorded figure');
  const thumbnail = tile.locator('img');
  await expect(thumbnail).toHaveAttribute(
    'src',
    new RegExp(`commit=${recorded}`)
  );
  await expect
    .poll(() =>
      thumbnail.evaluate(
        node =>
          node instanceof HTMLImageElement &&
          node.complete &&
          node.naturalWidth > 0
      )
    )
    .toBe(true);

  await tile.click();
  const record = page.locator('.jp-jupyterlab-lightcone-element:visible');
  await expect(record).toContainText('Older version');
  const preview = record.locator('img[src*="/api/versions/content?"]').first();
  await expect(preview).toHaveAttribute(
    'src',
    new RegExp(`commit=${recorded}`)
  );
  await expect(preview).toBeVisible();
  // The result opens beside the conversation, including its existing footer.
  await expect(composer).toBeVisible();
  const chatBounds = await composer.boundingBox();
  const recordBounds = await record.boundingBox();
  expect(chatBounds).not.toBeNull();
  expect(recordBounds).not.toBeNull();
  expect(recordBounds!.x).toBeGreaterThan(chatBounds!.x);
});
