import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launches the built app (npm run build) with the fake runtime: prerequisites and QA outcomes
 * come from the scenario, content comes from the local SupportDesk checkout.
 */
export async function launch(scenario: object = {}, options: { userData?: string } = {}): Promise<Launched> {
  // A data folder with a space and non-ASCII characters, like C:\Users\João Silva\AppData\Roaming.
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'João Silva e2e-')));
  // ELECTRON_RUN_AS_NODE (set when started from some editor processes) would turn Electron into plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...parentEnv } = process.env;
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '..', '..')],
    env: {
      ...parentEnv,
      BUGDETECTIVE_E2E: '1',
      BUGDETECTIVE_USER_DATA: userData,
      BUGDETECTIVE_E2E_SCENARIO: JSON.stringify(scenario),
    },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    close: async () => {
      await app.close();
      if (!options.userData) {
        await rm(userData, { recursive: true, force: true });
      }
    },
  };
}

/** Passes the checklist and unlocks the first ticket. */
export async function startFirstTicket(page: Page): Promise<void> {
  await page.getByTestId('start-playing').click();
  await page.getByTestId('next-assignment').click();
  await page.getByTestId('board').waitFor();
  await page.getByTestId('card-1').waitFor();
}

/**
 * Drags a card to an allowed column and checks that the board reacted (status or attempt count
 * changed). Native HTML5 drag and drop driven by Playwright occasionally loses a drop; the drag
 * is retried and the retry is logged, so the flake stays visible in the output.
 */
export async function dragCard(page: Page, ticket: number, column: 'inProgress' | 'inQa'): Promise<void> {
  const card = page.getByTestId(`card-${ticket}`);
  const before = { status: await card.getAttribute('data-status'), text: await card.textContent() };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await card.dragTo(page.getByTestId(`column-${column}`));
    try {
      await expect
        .poll(async () => (await card.getAttribute('data-status')) !== before.status || (await card.textContent()) !== before.text, { timeout: 3000 })
        .toBe(true);
      return;
    } catch {
      console.warn(`drag of card ${ticket} to ${column} was not registered (attempt ${attempt}), retrying`);
    }
  }
  const toasts = [...(await page.getByTestId('toast-error').allTextContents()), ...(await page.getByTestId('toast-info').allTextContents())];
  throw new Error(`Dragging card ${ticket} to ${column} had no effect${toasts.length ? ` (toasts: ${toasts.join(' | ')})` : ''}`);
}
