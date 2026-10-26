import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

test('the first-run checklist blocks the game until every prerequisite passes', async () => {
  const { page, close } = await launch({ docker: 'notRunning', devcontainers: false });
  try {
    await expect(page.getByTestId('checklist')).toBeVisible();
    await expect(page.getByTestId('check-docker')).toHaveAttribute('data-status', 'missing');
    await expect(page.getByTestId('check-wsl')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('check-vscode')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('check-devcontainers')).toHaveAttribute('data-status', 'missing');
    await expect(page.getByTestId('start-playing')).toBeDisabled();
    await expect(page.getByTestId('check-docker')).toContainText('installed but not running');

    await page.getByTestId('install-devcontainers').click();
    await expect(page.getByTestId('check-devcontainers')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('start-playing')).toBeDisabled();

    await page.getByTestId('start-docker').click();
    await expect(page.getByTestId('check-docker')).toHaveAttribute('data-status', 'ok');

    await page.getByTestId('check-again').click();
    await expect(page.getByTestId('start-playing')).toBeEnabled();
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('inbox-message')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('missing VS Code and WSL show instructions instead of an install button', async () => {
  const { page, close } = await launch({ vscode: false, wsl: false });
  try {
    await expect(page.getByTestId('check-vscode')).toHaveAttribute('data-status', 'missing');
    await expect(page.getByTestId('check-wsl')).toContainText('wsl --install');
    await expect(page.getByTestId('check-vscode').getByRole('button', { name: /How to install/ })).toBeVisible();
    await expect(page.getByTestId('install-devcontainers')).toHaveCount(0);
    await expect(page.getByTestId('start-playing')).toBeDisabled();
  } finally {
    await close();
  }
});

test('the app shows a banner and pauses Docker actions when Docker stops mid-session', async () => {
  const { page, close } = await launch({ stopDockerAfterUnlock: true });
  try {
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('docker-banner')).toHaveCount(0);
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('card-1').waitFor();
    await expect(page.getByTestId('docker-banner')).toBeVisible();
    await expect(page.getByTestId('docker-banner')).toContainText('Docker is not running');

    await page.getByTestId('card-1').click();
    await expect(page.getByTestId('open-vscode')).toBeDisabled();
    await expect(page.getByTestId('open-browser')).toBeDisabled();
    await page.getByTestId('close-panel').click();

    // Starting a ticket resets the workspace in Docker, so it is refused while Docker is down.
    // Retry only if the drop itself was lost (no toast at all).
    for (let attempt = 1; attempt <= 3 && !(await page.getByTestId('toast-error').count()); attempt += 1) {
      await page.getByTestId('card-1').dragTo(page.getByTestId('column-inProgress'));
      await page.getByTestId('toast-error').waitFor({ timeout: 5000 }).catch(() => console.warn(`drop to In Progress not registered (attempt ${attempt})`));
    }
    await expect(page.getByTestId('toast-error')).toContainText('Docker is not running');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'todo');

    await page.getByTestId('docker-banner').getByRole('button').click();
    await expect(page.getByTestId('docker-banner')).toHaveCount(0);
  } finally {
    await close();
  }
});
