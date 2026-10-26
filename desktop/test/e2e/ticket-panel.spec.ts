import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, startFirstTicket } from './fixtures.ts';

test('the ticket panel shows the ticket, QA comments, history and the senior-dev conversation', async () => {
  const { page, close } = await launch({ qa: ['gate2'] });
  try {
    await startFirstTicket(page);
    await page.getByTestId('card-1').click();
    const panel = page.getByTestId('ticket-panel');
    await expect(panel.getByTestId('ticket-title')).toContainText('SD-214');
    await expect(panel.getByTestId('ticket-markdown')).toContainText('Steps to reproduce');
    await expect(panel.getByTestId('open-vscode')).toBeEnabled();
    await expect(panel.getByTestId('open-browser')).toContainText(':5173');

    // Hints only from In Progress.
    await panel.getByTestId('tab-senior').click();
    await expect(panel.getByTestId('conversation')).toContainText('Move the card to In Progress');
    await expect(panel.getByTestId('ask-hint')).toHaveCount(0);
    await panel.getByTestId('close-panel').click();
    await page.getByTestId('card-1').dragTo(page.getByTestId('column-inProgress'));
    await page.getByTestId('card-1').click();
    await panel.getByTestId('tab-senior').click();

    for (let hint = 1; hint <= 3; hint += 1) {
      await panel.getByTestId('ask-hint').click();
      await expect(panel.getByTestId('chat-hint')).toHaveCount(hint);
      await expect(panel.getByTestId('hints-used')).toContainText(`${hint} of 3`);
    }
    await expect(panel.getByTestId('chat-hint').first()).toContainText('DevTools');
    await expect(panel.getByTestId('ask-hint')).toHaveCount(0);
    await panel.getByTestId('reveal-solution').click();
    await expect(panel.getByTestId('solution')).toContainText('Root cause');
    await expect(panel.getByTestId('solution-diff')).toContainText('TicketDetails.tsx');
    await expect(panel.getByTestId('reveal-solution')).toHaveCount(0);

    // QA failure: comment names the gate, lists failing tests with errors.
    await panel.getByTestId('close-panel').click();
    await page.getByTestId('card-1').dragTo(page.getByTestId('column-inQa'));
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inProgress', { timeout: 15_000 });
    await page.getByTestId('card-1').click();
    await panel.getByTestId('tab-qa').click();
    const comment = panel.getByTestId('qa-comment').first();
    await expect(comment).toHaveAttribute('data-kind', 'gate2Failed');
    await expect(comment).toContainText('Gate 2');
    await expect(comment).toContainText('Gate 2 failed: the reported bug is still unresolved');
    await expect(comment.getByTestId('qa-failing-test')).toContainText('Next shows the next ticket');
    await expect(comment.getByTestId('qa-failing-test')).toContainText('Expected "4", received "3"');

    // History: attempts and the append-only activity log.
    await panel.getByTestId('tab-history').click();
    await expect(panel.getByTestId('attempt')).toHaveCount(1);
    await expect(panel.getByTestId('activity-entry')).toHaveCount(4);
    await expect(panel.getByTestId('activity')).toContainText('In QA → In Progress');
    await expect(panel).toContainText('Hints used: 3 of 3');
    await expect(panel).toContainText('Solution revealed');
  } finally {
    await close();
  }
});

test('the game UI and the game texts switch to Portuguese, and state survives a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  try {
    const first = await launch({}, { userData });
    await startFirstTicket(first.page);
    await first.page.getByTestId('nav-settings').click();
    await first.page.getByTestId('language-select').selectOption('pt');
    await expect(first.page.getByTestId('nav-board')).toHaveText('Quadro');
    await first.close();

    const second = await launch({}, { userData });
    try {
      await second.page.getByTestId('nav-board').click();
      await second.page.getByTestId('card-1').click();
      await expect(second.page.getByTestId('ticket-markdown')).toContainText('Passos para reproduzir');
      await expect(second.page.getByTestId('ticket-title')).toContainText('Anterior e Próximo');
      await second.page.getByTestId('close-panel').click();
      await second.page.getByTestId('nav-dashboard').click();
      await expect(second.page.getByTestId('inbox')).toContainText('Seu primeiro ticket: SD-214');
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
