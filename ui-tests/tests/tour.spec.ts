import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

const TOOLTIP = '.react-joyride__tooltip';
const SPOTLIGHT = '.react-joyride__spotlight';
const TOUR = 'jupyterlab_lightcone:tour';
const START_NOW = 'Start now';

/** The step's title, read from react-joyride's heading rather than its body. */
function title(page: IJupyterLabPageFixture) {
  return page.locator(TOOLTIP).getByRole('heading');
}

async function next(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator(TOOLTIP).getByRole('button', { name: 'Next' }).click();
}

/** A minimal ASTRA project, created through Contents like the other suites. */
async function createProject(
  page: IJupyterLabPageFixture,
  directory: string
): Promise<void> {
  await page.contents.createDirectory(directory);
  await page.contents.uploadContent(
    'version: "0.0.14"\nname: Tour project\ninputs: []\noutputs: []\n',
    'text',
    `${directory}/astra.yaml`
  );
}

test('is offered once, explains the launcher and checks the agents', async ({
  page
}) => {
  // Outside any project, the launcher offers Create project and Open project.
  await page.locator('.jp-toast-button', { hasText: START_NOW }).click();
  await expect(title(page)).toHaveText('Welcome to Lightcone Lab');
  await next(page);
  await expect(title(page)).toHaveText('Create project');
  await expect(page.locator(SPOTLIGHT)).toBeVisible();
  await next(page);
  await expect(title(page)).toHaveText('Open project');
  await next(page);
  await expect(title(page)).toHaveText('Inside a project');
  await next(page);
  await expect(title(page)).toHaveText('Coding agents on this server');
  const tooltip = page.locator(TOOLTIP);
  // The check reports this server's PATH, so a developer machine may have an
  // adapter installed; an agent is either ready or given its install command.
  const installs: Record<string, string> = {
    'Claude Code': 'npm install -g @agentclientprotocol/claude-agent-acp',
    Codex: 'npm install -g @agentclientprotocol/codex-acp',
    OpenCode: 'npm install -g opencode-ai'
  };
  await expect(tooltip.locator('li')).toHaveCount(3);
  let missing = 0;
  for (const [agent, install] of Object.entries(installs)) {
    const row = tooltip.locator('li', { hasText: agent });
    const state = row.locator('.jp-jupyterlab-lightcone-TourAgents-state');
    await expect(state).toHaveText(/^(ready|not installed)$/);
    if ((await state.textContent()) === 'ready') {
      await expect(row.locator('code')).toHaveCount(0);
    } else {
      missing += 1;
      await expect(row.locator('code')).toHaveText(install);
    }
  }
  if (missing > 0) {
    await expect(tooltip).toContainText('restart the Jupyter server');
  }
  await next(page);
  await expect(title(page)).toHaveText('Choosing the agent');
  await tooltip.getByRole('button', { name: 'Done' }).click();
  await expect(tooltip).toHaveCount(0);

  // Taken once: a reload no longer offers it, while the Help menu still does.
  await page.goto();
  await page.locator('.jp-Launcher').waitFor();
  await expect(
    page.locator('.jp-toast-button', { hasText: START_NOW })
  ).toHaveCount(0);
  await page.menu.clickMenuItem('Help>Lightcone Lab Tour');
  await expect(title(page)).toHaveText('Welcome to Lightcone Lab');
  await page.locator(TOOLTIP).getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator(TOOLTIP)).toHaveCount(0);
});

test('describes the cards of the current project', async ({
  page,
  tmpPath
}) => {
  await createProject(page, `${tmpPath}/project`);
  await page.filebrowser.openDirectory(`${tmpPath}/project`);
  await expect(
    page.getByRole('button', { name: 'Lightcone Agent', exact: true })
  ).toBeVisible();
  await page.evaluate(
    command => window.jupyterapp.commands.execute(command),
    TOUR
  );
  await expect(title(page)).toHaveText('Welcome to Lightcone Lab');
  await next(page);
  for (const card of ['Lightcone Agent', 'ASTRA Inventory', 'MySTRA Viewer']) {
    await expect(title(page)).toHaveText(card);
    await expect(page.locator(SPOTLIGHT)).toBeVisible();
    await next(page);
  }
  await expect(title(page)).toHaveText('Outside a project');
  await next(page);
  await expect(title(page)).toHaveText('Coding agents on this server');
  await next(page);
  await expect(title(page)).toHaveText('Choosing the agent');
  await page.locator(TOOLTIP).getByRole('button', { name: 'Done' }).click();
  await expect(page.locator(TOOLTIP)).toHaveCount(0);
});
