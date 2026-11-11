import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: true,
  testDir: './test/browser',
  // Real-router measurements (load/measure/public/restorecheck) are opt-in: they need
  // MEASURE_REAL=1 and a reachable llama.cpp server, so the required suite never collects them.
  testIgnore:
    process.env.MEASURE_REAL === '1' ? [] : ['**/{load,measure,public,restorecheck}.spec.ts'],
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
