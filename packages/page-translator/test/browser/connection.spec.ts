import type { Page } from '@playwright/test';
import { expect, test as base, usedHeap } from '@chrome-toolbox/extension-core/testing';

/** The options page, opened in a tab as Chrome opens it (`open_in_tab`). */
const test = base.extend<{ options: Page }>({
  options: async ({ context, extensionId }, provide) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await provide(page);
  },
});

const connect = async (options: Page, origin: string): Promise<void> => {
  await options.getByLabel('llama.cpp の接続先').fill(origin);
  await options.getByRole('button', { name: '接続を確認' }).click();
};

test('options page connects to a local llama.cpp server through the service worker', async ({
  options,
  llama,
}) => {
  await connect(options, llama.origin);
  await expect(options.locator('output[data-status="connected"]')).toHaveText(
    '接続済み（モデル: stub-model）',
  );
  expect(llama.requests).toEqual(['GET /health', 'GET /v1/models']);
});

test('options page explains an unreachable server', async ({ options }) => {
  await connect(options, 'http://127.0.0.1:9');
  await expect(options.locator('output[data-status="failed"]')).toContainText(
    'llama.cpp に接続できません',
  );
});

test('repeated reconnects keep the options page heap bounded', async ({ options, llama }) => {
  await connect(options, llama.origin);
  await expect(options.locator('output[data-status="connected"]')).toBeVisible();
  const before = await usedHeap(options);
  const button = options.getByRole('button', { name: '接続を確認' });
  for (let round = 1; round <= 30; round += 1) {
    await button.click();
    await expect.poll(() => llama.requests.length).toBe(2 * (round + 1));
    await expect(options.locator('output[data-status="connected"]')).toBeVisible();
  }
  const after = await usedHeap(options);
  expect(after - before, `heap grew from ${before} to ${after} bytes`).toBeLessThan(1_000_000);
});
