/**
 * Runs ticket 1 end to end with the installed app (NSIS build) and a clean data folder:
 *
 *   dist\Bug-Detective-Setup-<version>.exe /S
 *   set BUGDETECTIVE_INSTALLED_EXE=%LOCALAPPDATA%\Programs\bug-detective\Bug Detective.exe
 *   npx playwright test --config playwright.manual.config.ts installed-ticket1
 *
 * No GitHub release is published yet, so the clean profile's content-source.json points at the
 * local SupportDesk copy.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..', '..');
const supportdesk = resolve(root, '..', 'supportdesk');
const DOCKER = process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker';
const CONTAINER = 'bugdetective-workspace';
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

test('the installed app plays ticket 1 end to end on a clean profile', async () => {
  const executablePath = process.env.BUGDETECTIVE_INSTALLED_EXE;
  test.skip(!executablePath, 'Set BUGDETECTIVE_INSTALLED_EXE');
  const userData = await mkdtemp(join(tmpdir(), 'João Silva installed-'));
  await writeFile(
    join(userData, 'content-source.json'),
    JSON.stringify({ kind: 'local', repoPath: supportdesk, manifestPath: join(root, 'build', 'stage-packages', 'manifest.json') }),
  );
  // Start from no workspace at all, like a new player.
  const leftovers = execFileSync(DOCKER, ['ps', '-aq', '--filter', 'label=bugdetective.role=qa'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean);
  for (const id of leftovers) execFileSync(DOCKER, ['rm', '--force', id], { stdio: 'ignore' });
  execFileSync(DOCKER, ['rm', '--force', CONTAINER], { stdio: 'ignore' });
  execFileSync(DOCKER, ['volume', 'rm', '--force', 'bugdetective-workspace'], { stdio: 'ignore' });

  const app = await electron.launch({ executablePath: executablePath!, env: { ...process.env, BUGDETECTIVE_USER_DATA: userData } });
  const page = await app.firstWindow();
  const versions = await app.evaluate(({ app: electronApp }) => ({ packaged: electronApp.isPackaged, path: electronApp.getAppPath() }));
  expect(versions.packaged).toBe(true);
  log(`installed app: ${versions.path}`);

  for (const id of ['docker', 'wsl', 'vscode', 'devcontainers']) {
    await expect(page.getByTestId(`check-${id}`)).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
  }
  await page.getByTestId('start-playing').click();

  const install = async () => {
    await page.getByTestId('nav-dashboard').click();
    const report = await page.evaluate(() => window.bugDetective.refreshEnvironment());
    if (!report.ready) {
      await expect(page.getByTestId('environment-panel')).toBeVisible();
      await page.getByTestId('install-environment').click();
      await expect(page.getByTestId('environment-panel')).toHaveCount(0, { timeout: 30 * 60_000 });
    }
  };
  await install();
  await page.getByTestId('next-assignment').click();
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 5 * 60_000 });
  await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'todo', { timeout: 120_000 });
  await install();
  log('ticket 1 unlocked, environment ready');

  await page.getByTestId('nav-board').click();
  const card = page.getByTestId('card-1');
  await card.dragTo(page.getByTestId('column-inProgress'));
  await expect(card).toHaveAttribute('data-status', 'inProgress');
  await card.dragTo(page.getByTestId('column-inQa'));
  await expect(card.or(page.getByTestId('toast-error'))).toBeVisible();
  await page.waitForTimeout(15_000);
  if ((await card.getAttribute('data-status')) !== 'inQa') {
    log(`move refused: ${await page.getByTestId('toast-error').allTextContents()} / ${await page.getByTestId('toast-info').allTextContents()}`);
  }
  await expect(card).toHaveAttribute('data-status', 'inQa');
  await expect(card).toHaveAttribute('data-status', 'inProgress', { timeout: 10 * 60_000 });
  await card.click();
  await page.getByTestId('tab-qa').click();
  await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'gate2Failed');
  await page.getByTestId('close-panel').click();
  log('QA on the buggy stage: Gate 2 failed');

  const patch = await readFile(join(supportdesk, 'qa', 'stages', 'stage-1', 'reference.patch'));
  execFileSync(DOCKER, ['exec', '-i', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'apply', '-'], { input: patch });
  await card.dragTo(page.getByTestId('column-inQa'));
  await expect(card).toHaveAttribute('data-status', 'inQa');
  await expect(card).toHaveAttribute('data-status', 'codeReview', { timeout: 10 * 60_000 });
  await card.click();
  await page.getByTestId('open-review').click();
  await page.getByTestId('accept-review').click();
  await expect(card).toHaveAttribute('data-status', 'done');
  log('QA passed, review accepted, ticket 1 Done');
  await app.close();
});
