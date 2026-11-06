import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: true,
  testDir: './test/browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile:
          process.env.STARTER_BROWSER_EVIDENCE ?? '../../artifacts/browser-extension.json',
      },
    ],
  ],
});
