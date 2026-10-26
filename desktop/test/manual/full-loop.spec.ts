/**
 * Drives the real app (real Docker Desktop, VS Code and content) through the whole game:
 * checklist, unlock, VS Code attach, QA fail, hints, solution, fix, QA pass, review, Done, for
 * all four tickets; restart during QA; export, volume deletion and restore.
 *
 *   npm run build && npx playwright test --config playwright.manual.config.ts
 *
 * Uses the real "bugdetective-*" Docker resources, and a fresh data folder per run.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const root = resolve(import.meta.dirname, '..', '..');
const supportdesk = resolve(root, '..', 'supportdesk');
const DOCKER = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const CONTAINER = 'bugdetective-workspace';

const docker = (...args: string[]) => execFileSync(DOCKER, args, { encoding: 'utf8' });
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function open(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [root], env: { ...process.env, BUGDETECTIVE_USER_DATA: userData } });
  const page = await app.firstWindow();
  return { app, page };
}

/** Installs whatever the environment panel lists, if it is shown. */
async function installEnvironment(page: Page) {
  await page.getByTestId('nav-dashboard').click();
  const report = await page.evaluate(() => window.bugDetective.refreshEnvironment());
  if (!report.ready) {
    await expect(page.getByTestId('environment-panel')).toBeVisible();
    const started = Date.now();
    await page.getByTestId('install-environment').click();
    await expect(page.getByTestId('environment-panel')).toHaveCount(0, { timeout: 30 * 60_000 });
    log(`environment installed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}

async function cardStatus(page: Page, ticket: number, status: string, timeout = 10 * 60_000) {
  await page.getByTestId('nav-board').click();
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', status, { timeout });
}

async function submitQa(page: Page, ticket: number, expected: 'inProgress' | 'codeReview') {
  const started = Date.now();
  await page.getByTestId(`card-${ticket}`).dragTo(page.getByTestId('column-inQa'));
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'inQa');
  await cardStatus(page, ticket, expected);
  log(`ticket ${ticket}: QA → ${expected} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

test('the full game loop on Windows with Docker Desktop', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva full-loop-'));
  let { app, page } = await open(userData);

  // First-run checklist with the real prerequisite checks.
  await expect(page.getByTestId('checklist')).toBeVisible();
  for (const id of ['docker', 'wsl', 'vscode']) {
    await expect(page.getByTestId(`check-${id}`)).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
  }
  await expect(page.getByTestId('check-devcontainers')).not.toHaveAttribute('data-status', 'pending', { timeout: 60_000 });
  if ((await page.getByTestId('check-devcontainers').getAttribute('data-status')) !== 'ok') {
    await expect(page.getByTestId('start-playing')).toBeDisabled();
    log('checklist: Dev Containers missing, installing it from the checklist');
    await page.getByTestId('install-devcontainers').click();
    await expect(page.getByTestId('check-devcontainers')).toHaveAttribute('data-status', 'ok', { timeout: 5 * 60_000 });
  }
  log('checklist: all four prerequisites ok');
  await page.getByTestId('start-playing').click();
  await installEnvironment(page);

  for (let ticket = 1; ticket <= 4; ticket += 1) {
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('next-assignment').click();
    // The app switches to the board once the unlock (and its environment check) has finished.
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 5 * 60_000 });
    await cardStatus(page, ticket, 'todo', 120_000);
    log(`ticket ${ticket}: unlocked`);
    await installEnvironment(page);
    expect(docker('exec', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'branch', '--show-current').trim()).toBe(`player/ticket-${ticket}`);

    // Open in VS Code, attached to the workspace container.
    await page.getByTestId('nav-board').click();
    await page.getByTestId(`card-${ticket}`).click();
    await page.getByTestId('open-vscode').click();
    await expect
      .poll(() => docker('exec', CONTAINER, 'sh', '-c', 'ps -eo args | grep -c "[v]scode-server" || true').trim(), { timeout: 5 * 60_000 })
      .not.toBe('0');
    log(`ticket ${ticket}: VS Code server running in the container`);

    if (ticket === 1) {
      // Open app in browser: the dev server on the published port, through the forwarder.
      await page.getByTestId('start-dev-server').click();
      const port = Number(/:(\d+)/.exec((await page.getByTestId('open-browser').textContent()) ?? '')?.[1]);
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/`).catch(() => null))?.status ?? 0, { timeout: 120_000 }).toBe(200);
      const tickets = (await (await fetch(`http://127.0.0.1:${port}/api/tickets`)).json()) as unknown[];
      expect(tickets.length).toBeGreaterThan(10);
      log(`ticket 1: app answers on http://127.0.0.1:${port}/ (${tickets.length} tickets through the Vite proxy)`);
    }
    await page.getByTestId('close-panel').click();

    await page.getByTestId(`card-${ticket}`).dragTo(page.getByTestId('column-inProgress'));
    await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'inProgress');

    if (ticket === 1) {
      // Close the app during QA, then start it again.
      await page.getByTestId('card-1').dragTo(page.getByTestId('column-inQa'));
      await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inQa');
      await page.waitForTimeout(5000);
      await app.close();
      log('ticket 1: app closed during QA');
      ({ app, page } = await open(userData));
      await cardStatus(page, 1, 'inProgress', 60_000);
      await page.getByTestId('card-1').click();
      await page.getByTestId('tab-qa').click();
      await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'interrupted');
      await page.getByTestId('tab-history').click();
      await expect(page.getByTestId('attempt')).toHaveCount(0);
      await expect.poll(() => docker('ps', '-a', '--filter', 'label=bugdetective.role=qa', '--format', '{{.Names}}').trim(), { timeout: 60_000 }).toBe('');
      await page.getByTestId('close-panel').click();
      log('ticket 1: restart recovered the interrupted QA run (no attempt counted, container removed)');
    }

    // QA on the buggy stage fails at Gate 2.
    await submitQa(page, ticket, 'inProgress');
    await page.getByTestId(`card-${ticket}`).click();
    await page.getByTestId('tab-qa').click();
    await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'gate2Failed');
    await expect(page.getByTestId('qa-comment').first().getByTestId('qa-failing-test').first()).toBeVisible();

    // Hints, then the solution.
    await page.getByTestId('tab-senior').click();
    for (let hint = 1; hint <= 3; hint += 1) {
      await page.getByTestId('ask-hint').click();
      await expect(page.getByTestId('chat-hint')).toHaveCount(hint);
    }
    await page.getByTestId('reveal-solution').click();
    await expect(page.getByTestId('solution-diff')).toBeVisible();
    await page.getByTestId('close-panel').click();
    log(`ticket ${ticket}: 3 hints and the solution revealed`);

    // The player applies the fix in the workspace.
    const patch = await readFile(join(supportdesk, 'qa', 'stages', `stage-${ticket}`, 'reference.patch'));
    execFileSync(DOCKER, ['exec', '-i', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'apply', '-'], { input: patch });

    await submitQa(page, ticket, 'codeReview');
    await page.getByTestId(`card-${ticket}`).click();
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('review-markdown')).toBeVisible();
    await expect(page.getByTestId('reference-diff')).toContainText('client/src');
    await expect(page.getByTestId('player-diff')).toContainText('client/src');
    await page.getByTestId('accept-review').click();
    await cardStatus(page, ticket, 'done');
    log(`ticket ${ticket}: review accepted, Done`);
  }

  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('inbox-message').first()).toHaveAttribute('data-kind', 'completion');
  await expect(page.getByTestId('tickets-done')).toContainText('4 of 4');
  log('all four tickets done; completion message received');

  // Export, delete the volume, restore.
  const save = join(userData, 'export test.bdsave');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as never;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never;
  }, save);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('export-progress').click();
  await expect(page.getByTestId('toast-info')).toContainText('Progress saved', { timeout: 120_000 });
  const head = docker('exec', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'rev-parse', 'HEAD').trim();
  docker('rm', '--force', CONTAINER);
  docker('volume', 'rm', 'bugdetective-workspace');
  log('exported, then deleted the workspace container and volume');

  await page.getByTestId('restore-progress').click();
  await expect(page.getByTestId('restore-warning')).toBeVisible();
  await page.getByTestId('confirm-restore').click();
  await expect(page.getByTestId('toast-info').last()).toContainText('Progress restored', { timeout: 5 * 60_000 });
  expect(docker('exec', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'rev-parse', 'HEAD').trim()).toBe(head);
  expect(docker('exec', '-u', 'node', '-w', '/workspaces/supportdesk', CONTAINER, 'git', 'branch', '--list', 'player/*')).toMatch(
    /player\/ticket-1[\s\S]*player\/ticket-4/,
  );
  await page.getByTestId('nav-board').click();
  for (let ticket = 1; ticket <= 4; ticket += 1) {
    await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'done');
  }
  await installEnvironment(page);
  log('restored: repository, branches and board state are back');
  await app.close();
});
