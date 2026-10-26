import { expect, test } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

test('the player can only drag To Do → In Progress → In QA; QA and review move the rest', async () => {
  const { page, close } = await launch({ qa: ['gate2', 'passed'], qaDelayMs: 800 });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await expect(card).toHaveAttribute('data-status', 'todo');

    // Forbidden drops are refused by the UI...
    for (const column of ['inQa', 'codeReview', 'done']) {
      await card.dragTo(page.getByTestId(`column-${column}`));
      await expect(page.getByTestId('toast-info').last()).toContainText('Only QA and the code review');
      await expect(card).toHaveAttribute('data-status', 'todo');
    }
    // ...and by the main process, even when the renderer asks directly.
    const direct = await page.evaluate(() => window.bugDetective.move(1, 'done').then(() => 'moved', (error: Error) => error.message));
    expect(direct).toContain('moveNotAllowed');

    await dragCard(page, 1, 'inProgress');
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    await card.dragTo(page.getByTestId('column-todo'));
    await expect(card).toHaveAttribute('data-status', 'inProgress');

    // In QA: the card cannot be dragged anywhere while QA runs, then comes back with a comment.
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-status', 'inQa');
    await expect(card).toHaveAttribute('draggable', 'false');
    const cancel = await page.evaluate(() => window.bugDetective.move(1, 'inProgress').then(() => 'moved', (error: Error) => error.message));
    expect(cancel).toMatch(/moveNotAllowed|busy/);
    await expect(card).toHaveAttribute('data-status', 'inProgress', { timeout: 15_000 });
    await expect(card).toContainText('1 QA attempt');

    // Second attempt passes: Code Review, then Done after accepting the review.
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await expect(card).toHaveAttribute('draggable', 'false');
    await card.click();
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('code-review')).toBeVisible();
    await expect(page.getByTestId('review-markdown')).toContainText('Why the bug happened');
    await expect(page.getByTestId('reference-diff')).toContainText('client/src/pages/TicketDetails.tsx');
    await expect(page.getByTestId('player-diff')).toContainText('fixed by the player');
    await page.getByTestId('accept-review').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'done');

    // One active ticket at a time: the next one is unlocked only now.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('inbox-message')).toHaveCount(1 + 1);
    await page.getByTestId('next-assignment').click();
    await expect(page.getByTestId('card-2')).toHaveAttribute('data-status', 'todo');
    await expect(page.getByTestId('card-1')).toHaveAttribute('draggable', 'false');
    const reopen = await page.evaluate(() => window.bugDetective.move(1, 'inProgress').then(() => 'moved', (error: Error) => error.message));
    expect(reopen).toContain('notActiveTicket');
  } finally {
    await close();
  }
});

test('Get Next Assignment is unavailable until the current ticket is Done', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('next-assignment')).toHaveCount(0);
    await expect(page.getByTestId('dashboard')).toContainText('Finish the current ticket');
    const result = await page.evaluate(() => window.bugDetective.nextAssignment().then(() => 'unlocked', (error: Error) => error.message));
    expect(result).toContain('ticketNotDone');
  } finally {
    await close();
  }
});

test('a QA timeout returns the card with the timeout template', async () => {
  const { page, close } = await launch({ qa: ['timeout'] });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(card).toContainText('1 QA attempt', { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    await card.click();
    await page.getByTestId('tab-qa').click();
    await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'timeout');
    await expect(page.getByTestId('qa-comment').first()).toContainText('180 seconds');
    await expect(page.getByTestId('qa-comment').first()).toContainText('Unfinished tests');
  } finally {
    await close();
  }
});
