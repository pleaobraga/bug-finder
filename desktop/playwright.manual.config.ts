import { defineConfig } from '@playwright/test';

/** The full-loop verification against the real runtime (Docker Desktop, VS Code). Windows only. */
export default defineConfig({
  testDir: 'test/manual',
  workers: 1,
  retries: 0,
  timeout: 90 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/manual',
});
