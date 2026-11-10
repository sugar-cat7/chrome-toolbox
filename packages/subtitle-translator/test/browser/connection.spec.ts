import { usedHeap } from '@chrome-toolbox/extension-core/testing';
import { expect, test } from './server.ts';

const connect = async (
  sidePanel: import('@playwright/test').Page,
  origin: string,
): Promise<void> => {
  // The connection settings live on the 詳細設定 tab.
  await sidePanel.getByRole('tab', { name: '詳細設定' }).click();
  await sidePanel.getByLabel('llama.cpp の接続先').fill(origin);
  await sidePanel.getByRole('button', { name: '接続を確認' }).click();
};

test('side panel connects to a local llama.cpp server through the service worker', async ({
  sidePanel,
  llama,
}) => {
  await connect(sidePanel, llama.origin);
  await expect(sidePanel.locator('output[data-status="connected"]')).toHaveText(
    '接続済み（モデル: stub-model）',
  );
  expect(llama.requests).toEqual(['GET /health', 'GET /v1/models']);
});

test('side panel explains an unreachable server', async ({ sidePanel }) => {
  await connect(sidePanel, 'http://127.0.0.1:9');
  await expect(sidePanel.locator('output[data-status="failed"]')).toContainText(
    'llama.cpp に接続できません',
  );
});

test('repeated reconnects keep the side panel heap bounded', async ({ sidePanel, llama }) => {
  await connect(sidePanel, llama.origin);
  await expect(sidePanel.locator('output[data-status="connected"]')).toBeVisible();
  const before = await usedHeap(sidePanel);
  const button = sidePanel.getByRole('button', { name: '接続を確認' });
  for (let round = 1; round <= 30; round += 1) {
    await button.click();
    await expect.poll(() => llama.requests.length).toBe(2 * (round + 1));
    await expect(sidePanel.locator('output[data-status="connected"]')).toBeVisible();
  }
  const after = await usedHeap(sidePanel);
  expect(after - before, `heap grew from ${before} to ${after} bytes`).toBeLessThan(1_000_000);
});
