import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: true,
  testDir: './test/browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  updateSnapshots: 'none',
  use: {
    baseURL: process.env.STARTER_TEST_ORIGIN,
    browserName: 'chromium',
    launchOptions: { args: ['--disable-lcd-text'] },
    viewport: { width: 960, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  snapshotPathTemplate: '{testDir}/snapshots/{arg}{ext}',
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: `../../artifacts/browser${process.env.STARTER_BROWSER_MODE === 'production' ? '-production' : ''}.json`,
      },
    ],
  ],
});
