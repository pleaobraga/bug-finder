import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
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
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '..', '..')],
    env: {
      ...process.env,
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
